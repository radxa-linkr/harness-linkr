#!/usr/bin/env node
/** Real browser + MCP App host simulator + fake device. No real host input. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakeDevice } from '../dsh-linkr/test/fake-device.mjs';
import { createLinkrTools } from '../mcp-linkr/tools.js';
import { createPanelBridge } from '../mcp-linkr/panel.js';
import { LinkrClient } from '../dsh-linkr/lib/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const playwright = process.env.PLAYWRIGHT_MODULE_DIR
  ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_DIR, 'playwright/index.mjs')))
  : await import('playwright');
const { expect } = process.env.PLAYWRIGHT_MODULE_DIR
  ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_DIR, 'playwright/test.mjs')))
  : await import('playwright/test');
const scratch = await mkdtemp(join(tmpdir(), 'linkr-panel-browser-'));
const priorStateDir = process.env.LINKR_STATE_DIR;
process.env.LINKR_STATE_DIR = join(scratch, 'state');
const fake = createFakeDevice({ initialCodec: 0 });
const originalClipboardStatus = LinkrClient.prototype.clipboardStatus;
let clipboardAvailable = false, clipboardProbes = 0;
LinkrClient.prototype.clipboardStatus = async () => {
  clipboardProbes += 1;
  return { available: clipboardAvailable, reason: clipboardAvailable ? '' : 'disabled', text: 'private clipboard fixture' };
};
const origin = await fake.listen();
const tools = createLinkrTools({ settingsFile: join(scratch, 'config.json'), client: { baseUrl: '', username: '', password: '', codec: 'mjpeg', manageVideoMode: true, idleStopMs: 60000 }, saveDir: join(scratch, 'captures'), inlineImages: true, inlineMaxBytes: 4 * 1024 * 1024 });
const panel = createPanelBridge(tools);
const app = (await panel.resource()).contents[0];
const cspOrigin = app._meta.ui.csp.connectDomains[0];
let port, queue = Promise.resolve();
const mcpArguments = [];
const host = createServer(async (req, res) => {
  try {
    if (req.url === '/ui') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: ${cspOrigin}; connect-src ${cspOrigin}; frame-ancestors http://127.0.0.1:${port}` });
      res.end(app.text); return;
    }
    if (req.url === '/rpc' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { name, arguments: args } = JSON.parse(body);
      mcpArguments.push({ name, args });
      const result = await (queue = queue.then(() => tools.callTool(name, args)));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: result.content, structuredContent: result.value, isError: result.isError, ...(name === 'linkr_panel' ? { _meta: await panel.metadata() } : {}) })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body style="margin:0"><iframe id="app" src="http://localhost:${port}/ui" sandbox="allow-scripts allow-same-origin" style="display:block;width:100vw;height:100vh;border:0"></iframe><script>
      const frame=document.getElementById('app');
      window.addEventListener('message',async event=>{
        if(event.source!==frame.contentWindow)return;
        const {id,method,params}=event.data||{};if(id==null)return;
        try{
          let result;
          if(method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'Linkr test host',version:'26.1108.1'},hostCapabilities:{serverTools:{},serverResources:{}},hostContext:{theme:new URL(location.href).searchParams.get('theme')||'light'}};
          else if(method==='tools/call')result=await(await fetch('/rpc',{method:'POST',body:JSON.stringify(params)})).json();
          else result={};
          frame.contentWindow.postMessage({jsonrpc:'2.0',id,result},event.origin);
        }catch(error){frame.contentWindow.postMessage({jsonrpc:'2.0',id,error:{code:-32603,message:error.message}},event.origin);}
      });
    </script></body></html>`);
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
port = host.address().port;
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const output = join(root, 'build/panel-verification'); await mkdir(output, { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 812 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log('PAGE ERROR', error.message); });
  await page.goto(`http://127.0.0.1:${port}`);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#viewer')).toHaveCount(1);
  await expect(frame.locator('#settings-view')).toBeVisible();
  await expect(frame.locator('#save-settings')).toBeEnabled();
  assert.equal(fake.whepCalls, 0);
  await frame.locator('#base-url').fill(origin);
  await frame.locator('#username').fill('tester');
  await frame.locator('#password').fill('wrong-password');
  await frame.locator('#password').press('Enter');
  await expect(frame.locator('#settings-error')).toContainText('登录失败');
  assert.equal(fake.whepCalls, 0);
  await frame.locator('#password').fill('s3cret');
  await frame.locator('#save-settings').click();
  await expect(frame.locator('#settings-view')).toBeHidden();
  await expect(frame.locator('#connection')).toHaveText('实时', { timeout: 10000 });
  await expect(frame.locator('#open-console')).toBeEnabled();
  await expect(frame.locator('#clipboard-status')).toBeVisible();
  await expect(frame.locator('#clipboard-status')).toHaveAttribute('title', 'Linkrd 未安装或未启用');
  const statusRow = await frame.locator('#clipboard-status').evaluate(el => el.parentElement.querySelector('#connection') !== null);
  assert.ok(statusRow, 'clipboard warning must share the connection status row');
  await expect(frame.locator('#guide h2')).toHaveText('安装 Linkrd（可选）');
  await expect(frame.locator('#guide li')).toHaveCount(6);
  await expect(frame.locator('#guide')).toContainText('挂载 Linkrd.img');
  await frame.locator('#settings').click();
  await expect(frame.locator('#password')).toHaveValue('');
  await expect(frame.locator('#password-note')).toHaveText('已保存密码，此处不回显。');
  for (const [width, height, theme] of [[390, 812, 'light'], [768, 1024, 'dark'], [1440, 1000, 'light']]) {
    await page.setViewportSize({ width, height });
    await frame.locator('html').evaluate((el, theme) => { el.style.colorScheme = theme; }, theme);
    assert.ok(await frame.locator('html').evaluate(el => el.scrollWidth <= window.innerWidth), 'settings overflow');
    await page.screenshot({ path: join(output, `settings-${width}-${theme}.png`), fullPage: false });
  }
  await frame.locator('#fps').fill('12');
  await frame.locator('#save-settings').click();
  await expect(frame.locator('#settings-view')).toBeHidden();
  await expect(frame.locator('#connection')).toHaveText('实时', { timeout: 10000 });
  await expect(frame.locator('#transport')).not.toContainText('兼容预览');
  await page.setViewportSize({ width: 390, height: 812 });
  await frame.locator('html').evaluate(el => { el.style.colorScheme = 'light'; });
  const picture = await frame.locator('#picture').evaluate(img => ({ width: img.naturalWidth, height: img.naturalHeight }));
  assert.equal(picture.width, 640); assert.equal(picture.height, 360);
  await frame.locator('#screen').click();
  await frame.locator('#screen').press('a');
  assert.equal(fake.hidFrames.length, 0, 'passive viewing injected input');
  await frame.locator('#takeover').check();
  await expect(frame.locator('#control-state')).toHaveText('已接管 · Esc 退出');
  await frame.locator('#screen').click();
  await fake.waitForHid(3);
  await frame.locator('#screen').press('a'); await fake.waitForHid(5);
  const bounds = await frame.locator('#screen').boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, 160); await fake.waitForHid(6);
  await page.mouse.move(bounds.x + bounds.width / 3, bounds.y + bounds.height / 2);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * 2 / 3, bounds.y + bounds.height / 2); await page.mouse.up();
  await fake.waitForHid(13);
  await frame.locator('#paste-toggle').click();
  await frame.locator('#text').fill('A');
  await frame.locator('#send-text').click();
  await fake.waitForHid(17);
  await frame.locator('#text').fill('b');
  await frame.locator('#text').press('Enter');
  await fake.waitForHid(19);
  for (const [width, height, theme] of [[390, 812, 'light'], [768, 1024, 'dark'], [1440, 900, 'light']]) {
    await page.setViewportSize({ width, height });
    await frame.locator('html').evaluate((el, theme) => { el.style.colorScheme = theme; }, theme);
    await frame.locator('body').evaluate(() => window.scrollTo(0, 0));
    console.log(JSON.stringify({ width, theme, button: await frame.locator('#capture').evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor, colorScheme: getComputedStyle(el).colorScheme })) }));
    assert.ok(await frame.locator('html').evaluate(el => el.scrollWidth <= window.innerWidth), 'horizontal overflow');
    await page.screenshot({ path: join(output, `panel-${width}-${theme}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1440, height: 1920 });
  await frame.locator('body').evaluate(() => window.scrollTo(0, 0));
  // Capture the app itself after its iframe has repainted at the new viewport.
  // An immediate outer-page capture can retain stale OOPIF compositor tiles.
  await frame.locator('main').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await frame.locator('main').screenshot({ path: join(output, 'panel-dsh-layout.png') });
  await frame.locator('#screen').press('Escape');
  await expect(frame.locator('#takeover')).not.toBeChecked();
  await frame.locator('#stop').click();
  await expect(frame.locator('#connection')).toHaveText('已断开'); assert.equal(fake.codec, 0);
  await expect(frame.locator('#picture')).toBeHidden();
  await expect(frame.locator('#screen-hint')).toBeHidden();
  await expect(frame.locator('#clipboard-status')).toBeHidden();
  const beforeProbe = clipboardProbes;
  clipboardAvailable = true;
  await frame.locator('#start').click();
  await expect(frame.locator('#connection')).toHaveText('实时', { timeout: 10000 });
  await expect.poll(() => clipboardProbes).toBeGreaterThan(beforeProbe);
  await expect(frame.locator('#clipboard-status')).toBeHidden();
  await frame.locator('#stop').click();
  await expect(frame.locator('#connection')).toHaveText('已断开');
  await page.route('**/status.json', route => route.abort());
  await frame.locator('#start').click();
  await expect(frame.locator('#transport')).toHaveText('兼容预览 · 最高 2 fps', { timeout: 10000 });
  await expect(frame.locator('#connection')).toHaveText('实时', { timeout: 10000 });
  await frame.locator('#stop').click();
  await expect(frame.locator('#connection')).toHaveText('已断开');
  assert.ok(!JSON.stringify(mcpArguments).includes('s3cret'), 'login password entered MCP tool arguments');
  await frame.locator('#settings').click();
  await expect(frame.locator('#password')).toHaveValue('');
  await frame.locator('#logout').click();
  await expect(frame.locator('#settings-title')).toHaveText('登录 Linkr');
  assert.equal(errors.length, 0, errors.join('\n')); assert.equal(fake.codec, 0);
  console.log(JSON.stringify({ pass: true, device: 'fake', picture, hidFrames: fake.hidFrames.length, viewports: [390, 768, 1440], fallback: 'verified', errors, screenshots: output }));
  await context.close();
} finally {
  await browser.close(); await panel.close(); await tools.dispose(); await fake.close();
  LinkrClient.prototype.clipboardStatus = originalClipboardStatus;
  await new Promise(resolve => { host.close(resolve); host.closeAllConnections(); });
  await rm(scratch, { recursive: true, force: true });
  if (priorStateDir === undefined) delete process.env.LINKR_STATE_DIR; else process.env.LINKR_STATE_DIR = priorStateDir;
}
