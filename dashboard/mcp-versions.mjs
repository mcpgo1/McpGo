import fs from 'node:fs';
import path from 'node:path';

// Versions identify LOCAL MCP server implementations, not ChatGPT's
// user-created plugin record, which cannot be inspected from this Mac.
const VALID=/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
function versionAt(file) {
  try {
    const info=JSON.parse(fs.readFileSync(file,'utf8'));
    return typeof info.version==='string' && VALID.test(info.version)?info.version:null;
  } catch {return null}
}
export function mcpVersions(root) {
  return {
    terminal:versionAt(path.join(root,'terminal','mcp-version.json')),
    playwright:versionAt(path.join(root,'playwright','node_modules','@playwright','mcp','package.json'))
  };
}
