'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const jobs = require('./job_runtime.js');
const MCP_VERSION=require('./mcp-version.json').version;

const DIR = __dirname;
const CONFIG = process.env.MCPGO_ONESHOT_CONFIG || path.join(os.homedir(),'Library','Application Support','McpGo','terminal','stateless-config.json');
fs.mkdirSync(path.dirname(CONFIG),{recursive:true,mode:0o700});
const PORT = Number(process.env.MCPGO_ONESHOT_PORT || 12848);
if(!Number.isInteger(PORT)||PORT<1024||PORT>65535)throw Error('INVALID_ONESHOT_PORT');

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
  description: 'Execute a macOS command via the persistent McpGo job runtime (default 30 sec, max 90 sec). Each call automatically gets job_id/operation_id, even if you did not provide one. After connection loss call mcpgo_recover/job_status: NEVER blindly re-execute. Optional stable request_id prevents duplicate execution; optional resource_key locks known conflicting resources only. Four unrelated agents remain parallel.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string' },
      request_id: {type:'string',minLength:8,maxLength:128,description:'Optional client idempotency token. If omitted, the generated job_id can still be recovered by mcpgo_recover after disconnect.'},
      resource_key: {type:'string',description:'Optional exclusive lock for a known conflicting operation, e.g. deploy:gafus-prod, release:mcpgo, git:repo-main. Unrelated operations always execute in parallel.'},
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

let active = 0;
// Preserve the familiar terminal_exec API, but run commands through the SAME
// durable job engine as job_start. This creates recoverable IDs automatically.
// An HTTP/MCP disconnect never kills or replays an existing command.
async function execute(args) {
  active++;
  try {
    const timeout_ms=args.timeout_ms??30000;
    if(!Number.isInteger(timeout_ms)||timeout_ms<1000||timeout_ms>90000)
      throw Error('INVALID_TIMEOUT');
    const started=jobs.startJob({...args,timeout_ms});
    const job_id=started.job_id;
    const deadline=Date.now()+timeout_ms+2000;
    let status;
    do {
      status=jobs.getStatus({job_id});
      if(['exited','cancelled','launch_error','unknown','stalled'].includes(status.state))break;
      const remaining=deadline-Date.now();
      if(remaining<=0)break;
      await jobs.watch({job_id,wait_ms:Math.min(2500,remaining)});
    } while(Date.now()<deadline);
    const result=jobs.result({job_id});
    return {
      operation_id:job_id,job_id,deduplicated:!!started.deduplicated,
      state:result.state,exit_code:result.exit_code??null,
      signal:result.signal??null,timed_out:!!result.timed_out,
      spawn_error:result.spawn_error??null,duration_ms:result.duration_ms??null,
      stdout:result.stdout||'',stderr:result.stderr||'',
      stdout_bytes:result.stdout_bytes??0,stderr_bytes:result.stderr_bytes??0,
      stdout_truncated:!!result.stdout_truncated,
      stderr_truncated:!!result.stderr_truncated,
      result_ready:result.result_ready===true,
      note:result.result_ready?'Durable result confirmed.':
        'The command may still run or may have applied changes. Call job_status or mcpgo_recover; NEVER automatically re-execute.'
    };
  } finally {active--}
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
          version: MCP_VERSION
        },
        instructions: 'Every terminal_exec and job_start is a durable operation with job_id. On lost response call mcpgo_recover and inspect job_status before repeating. Do not replay uncertain operations. resource_key locks only known conflicting resources; unrelated agents run concurrently.'
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
               ['job_start', 'job_status', 'job_logs', 'job_recent','job_cancel','job_result','job_watch','job_output','mcpgo_recover','resource_lock_status'].includes(params?.name)) {
      try {
        const args = params.arguments || {};
        const value = params.name === 'job_start' ? jobs.startJob(args)
                    : params.name === 'job_status' ? jobs.getStatus(args)
                    : params.name === 'job_recent' ? jobs.recent(args)
                    : params.name === 'job_cancel' ? jobs.cancel(args)
                    : params.name === 'job_result' ? jobs.result(args)
                    : params.name === 'job_watch' ? await jobs.watch(args)
                    : params.name === 'job_output' ? jobs.output(args)
                    : params.name === 'mcpgo_recover' ? jobs.recover(args)
                    : params.name === 'resource_lock_status' ? jobs.lockStatus(args)
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
