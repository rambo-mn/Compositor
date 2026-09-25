// Development helper: launches the built app headlessly, optionally runs a script against the page, and saves
// a screenshot. Usage: node scripts/shot.mjs out.png [script.js] (run under xvfb-run on Linux).
import { _electron as electron } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [out = 'shot.png', scriptFile] = process.argv.slice(2);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'compositor-shot-'));
fs.writeFileSync(path.join(userData, 'window-state.json'), JSON.stringify({ width: 1400, height: 900, maximized: false }));
const app = await electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/electron' + (process.platform === 'win32' ? '.exe' : '')),
  args: [root, '--no-sandbox'],
  env: { ...process.env, COMPOSITOR_TEST: '1', COMPOSITOR_USER_DATA: userData },
});
const page = await app.firstWindow();
page.on('console', (message) => console.log(`[page ${message.type()}]`, message.text()));
page.on('pageerror', (error) => console.log('[page error]', error.message));
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(800);
if (scriptFile) {
  const source = await readFile(scriptFile, 'utf8');
  const run = new Function('page', 'app', `return (async () => { ${source} })()`);
  await run(page, app);
}
await page.screenshot({ path: out });
console.log('saved', out);
await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
