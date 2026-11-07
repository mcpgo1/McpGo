'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const jobs = require('./job_runtime.js');

const DIR = __dirname;
const CONFIG = path.join(os.homedir(),'Library','Application Support','McpGo','terminal','stateless-config.json');
fs.mkdirSync(path.dirname(CONFIG),{recursive:true,mode:0o700});
const PORT = 12848;

if (!fs.existsSync(CONFIG)) {
  fs.writeFileSync(CONFIG, JSON.stringify({
    mcpPath: 'exec/' + crypto.randomBytes(32).toString('hex')
  }), { mode: 0o600, flag: 'wx' });
}

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
if (!/^exec\/[a-f0-9]{64}$/.test(config.mcpPath)) {
  throw new Error('Invalid private MCP path');
}

const tool = {
  name: 'terminal_exec',
  description: 'Execute one command on the user-owned Mac. No persistent terminal session. Returns stdout, stderr, exit code and timeout status. Maximum 90 seconds. Do not repeat an unknown or timed-out operation without checking its effects.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string' },
      timeout_ms: {
        type: 'integer',
        minimum: 1000,
        maximum: 90000
      }
    },
    required: ['command'],
    additionalProperties: false
  }
};

const MAX_OUTPUT = 12000;
let active = 0;

function outputCollector() {
  let buffer = Buffer.alloc(0);
  let total = 0;

  return {
    add(chunk) {
      total += chunk.length;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_OUTPUT) {
        buffer = buffer.subarray(buffer.length - MAX_OUTPUT);
      }
    },
    value() {
      return {
        text: buffer.toString('utf8'),
        bytes: total,
        truncated: total > MAX_OUTPUT
      };
    }
  };
}

function execute(args) {
  return new Promise((resolve, reject) => {
    if (typeof args.command !== 'string' ||
        !args.command.trim() ||
        Buffer.byteLength(args.command) > 16000) {
      return reject(new Error('INVALID_COMMAND'));
    }

    const cwd = args.cwd || os.homedir();
    if (!path.isAbsolute(cwd) ||
        !fs.existsSync(cwd) ||
        !fs.statSync(cwd).isDirectory()) {
      return reject(new Error('INVALID_CWD'));
    }

    const timeout = args.timeout_ms ?? 30000;
    if (!Number.isInteger(timeout) ||
        timeout < 1000 || timeout > 90000) {
      return reject(new Error('INVALID_TIMEOUT'));
    }

    const started = Date.now();
    const stdout = outputCollector();
    const stderr = outputCollector();

    let timedOut = false;
    let finished = false;
    let spawnError = null;

    active++;

    const child = spawn('/bin/zsh', ['-lc', args.command], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: os.homedir(),
        USER: os.userInfo().username,
        LOGNAME: os.userInfo().username,
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'en_US.UTF-8',
        TMPDIR: os.tmpdir()
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        setTimeout(() => {
          if (!finished) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch {}
          }
        }, 1500).unref();
      }
    }, timeout);

    child.stdout.on('data', chunk => stdout.add(chunk));
    child.stderr.on('data', chunk => stderr.add(chunk));

    child.on('error', error => {
      spawnError = error.message;
    });

    child.on('close', (code, signal) => {
      finished = true;
      clearTimeout(timer);
      active--;

      const out = stdout.value();
      const err = stderr.value();

      resolve({
        exit_code: code,
        signal: signal || null,
        timed_out: timedOut,
        spawn_error: spawnError,
        duration_ms: Date.now() - started,
        stdout: out.text,
        stderr: err.text,
        stdout_bytes: out.bytes,
        stderr_bytes: err.bytes,
        stdout_truncated: out.truncated,
        stderr_truncated: err.truncated
      });
    });
  });
}

function respond(res, status, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);

  if (req.method === 'GET' && url.pathname === '/health') {
    return respond(res, 200, {
      ok: true,
      mode: 'one-shot-mcp',
      active
    });
  }

  if (url.pathname !== '/' + config.mcpPath) {
    return respond(res, 404, { error: 'NOT_FOUND' });
  }

  if (req.method !== 'POST') {
    return respond(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const chunks = [];
    let size = 0;

    for await (const chunk of req) {
      size += chunk.length;
      if (size > 70000) throw new Error('REQUEST_TOO_LARGE');
      chunks.push(chunk);
    }

    const request = JSON.parse(Buffer.concat(chunks).toString());
    const { id, method, params } = request;

    if (id === undefined) {
      res.writeHead(202);
      return res.end();
    }

    let result;

    if (method === 'initialize') {
      result = {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'ChatTerminalHub OneShot',
          version: '1.1.0'
        }
      };
    } else if (method === 'ping') {
      result = {};
    } else if (method === 'tools/list') {
      result = { tools: [tool, ...jobs.tools] };
    } else if (method === 'tools/call' &&
               params?.name === 'terminal_exec') {
      try {
        const value = await execute(params.arguments || {});
        result = {
          content: [{
            type: 'text',
            text: JSON.stringify(value)
          }]
        };
      } catch (error) {
        result = {
          isError: true,
          content: [{
            type: 'text',
            text: error.message
          }]
        };
      }
    } else if (method === 'tools/call' &&
               ['job_start', 'job_status', 'job_logs'].includes(params?.name)) {
      try {
        const args = params.arguments || {};
        const value = params.name === 'job_start' ? jobs.startJob(args)
                    : params.name === 'job_status' ? jobs.getStatus(args)
                    : jobs.logs(args);
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    } else {
      return respond(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' }
      });
    }

    return respond(res, 200, { jsonrpc: '2.0', id, result });
  } catch (error) {
    return respond(res, 400, { error: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('ChatTerminalHub OneShot listening on 127.0.0.1:12848');
});
