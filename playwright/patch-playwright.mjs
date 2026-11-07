/**
 * Compatibility patch for Playwright MCP 0.0.83 / playwright-core 1.64-alpha.
 * In personal Chrome, a page may never resolve page.title() (e.g. modal or
 * devtools page), and browser_tabs(list) awaits titles of EVERY open tab.
 * Bound the optional per-tab metadata, not the whole MCP operation.
 * Applied after npm ci; fail closed if an upstream version changes the block.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const original = `      async headerSnapshot() {
        let title;
        let consoleCounts = { total: 0, errors: 0, warnings: 0 };
        if (!this.crashed) {
          await this._raceAgainstModalStates(async () => {
            title = await this.page.title();
          });
          consoleCounts = await this.consoleMessageCount();
        }
`;
const previousPatched = `      async headerSnapshot() {
        let title;
        let consoleCounts = { total: 0, errors: 0, warnings: 0 };
        if (!this.crashed) {
          // McpGo: an unresponsive tab must not block listing all personal Chrome tabs.
          let metadataTimer;
          try {
            await Promise.race([
              this._raceAgainstModalStates(async () => { title = await this.page.title(); }),
              new Promise(resolve => { metadataTimer = setTimeout(resolve, 2500); })
            ]);
          } finally { clearTimeout(metadataTimer); }
          let consoleTimer;
          try {
            consoleCounts = await Promise.race([
              this.consoleMessageCount(),
              new Promise(resolve => { consoleTimer = setTimeout(() => resolve(consoleCounts), 1200); })
            ]);
          } finally { clearTimeout(consoleTimer); }
        }
`;
const patched = `      async headerSnapshot() {
        let title;
        let consoleCounts = { total: 0, errors: 0, warnings: 0 };
        if (!this.crashed) {
          // McpGo: reuse a pending title request for an unresponsive Chrome tab.
          // Otherwise each bounded browser_tabs call leaves another modal listener.
          const currentUrl = this.page.url();
          let request = this._mcpGoTitleRequest;
          if (!request || request.url !== currentUrl || request.finished) {
            request = { url: currentUrl, title: void 0, finished: false, promise: null };
            const active = request;
            request.promise = this._raceAgainstModalStates(async () => {
              active.title = await this.page.title();
            }).catch(() => {}).finally(() => { active.finished = true; });
            this._mcpGoTitleRequest = request;
          }
          let metadataTimer;
          try {
            await Promise.race([
              request.promise,
              new Promise(resolve => { metadataTimer = setTimeout(resolve, 2500); })
            ]);
          } finally { clearTimeout(metadataTimer); }
          title = request.title;
          let consoleTimer;
          try {
            consoleCounts = await Promise.race([
              this.consoleMessageCount(),
              new Promise(resolve => { consoleTimer = setTimeout(() => resolve(consoleCounts), 1200); })
            ]);
          } finally { clearTimeout(consoleTimer); }
        }
`;
export function patchSource(source) {
  if (source.includes(patched)) return {source,modified:false};
  const match = source.includes(previousPatched) ? previousPatched : original;
  if (source.split(match).length !== 2) throw Error('Unsupported Playwright bundle: headerSnapshot() signature changed');
  return {source:source.replace(match,patched),modified:true};
}
const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const file=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'node_modules/playwright-core/lib/coreBundle.js');
  const source=fs.readFileSync(file,'utf8');
  const result=patchSource(source);
  if (result.modified) fs.writeFileSync(file,result.source);
  console.log(result.modified?'McpGo Playwright metadata timeout patch applied':'McpGo Playwright metadata patch already applied');
}
