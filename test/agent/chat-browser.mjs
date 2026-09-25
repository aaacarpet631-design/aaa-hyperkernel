/* Real mobile DOM and server runtime; provider/MCP responses are deterministic
 * fixtures. Run with PLAYWRIGHT_MODULE pointing to a Playwright installation. */
/* global window, document, innerWidth, AAA_CHAT_MESSAGE_STORE, AAA_OFFLINE_CHAT_QUEUE, AAA_DATA */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHandler } from '../../netlify/functions/agent.mjs';
import { executeTool } from '../../netlify/lib/agent-tools.mjs';
import { MemoryStore, toolResponse, finalResponse } from './helpers.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(import.meta.dirname, '../..');
const env = { OPENAI_API_KEY: 'fixture', MCP_TOKEN: 'fixture', AGENT_MCP_SERVERS: JSON.stringify([{ id: 'fixture', label: 'Test connection', url: 'https://mcp.example/mcp', users: ['owner'], tokenEnv: 'MCP_TOKEN', readTools: [], reviewTools: ['create_issue'] }]) };
let externalCalls = 0;
const handler = createHandler({ env, store: new MemoryStore(), authorize: async () => 'owner', budget: async () => {},
  provider: async run => {
    if (run.modelCalls > 1) return finalResponse('Completed the requested work. <script>window.unsafe = true</script>');
    if (run.transcript[0].content.includes('external')) return toolResponse('connected_tool', { connection: 'fixture', tool: 'create_issue', arguments_json: '{"title":"Review this exact title"}' });
    return toolResponse('create_file', { filename: 'report.md', content: '# Actual file result\nGenerated in the browser test.' });
  },
  execute: (call, args, ctx) => executeTool(call, args, { ...ctx, mcpCall: async () => { externalCalls++; return { ok: true, text: 'Issue created' }; } })
});
const scripts = ['js/core/runtime-clock.js', 'js/core/id-factory.js', 'js/core/local-first-storage.js', 'js/core/aaa-data.js', 'js/copilot/chat-message-store.js', 'js/copilot/offline-chat-queue.js', 'js/copilot/rich-card-renderer.js', 'js/copilot/task-agent.js', 'js/copilot/task-chat-ui.js', 'js/copilot/chat-canvas.js', 'js/copilot/copilot-ui.js'];
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/task-chat.css"><style>body{background:#09090b;color:#f4f4f5;font-family:system-ui;margin:18px}*{box-sizing:border-box}</style></head><body><main id="root"></main><script>window.AAA_CONFIG={workspaceId:'fixture',premiumModel:'gpt-6-astra',sessionHeaders:()=>({authorization:'Bearer fixture'})};</script>${scripts.map(p => '<script src="/' + p + '"></script>').join('')}<script>AAA_LOCAL_FIRST_STORAGE.boot().then(()=>AAA_COPILOT_UI.mountChat(document.getElementById('root')).ready).then(()=>window.ready=true);</script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/api/agent') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const result = await handler(new Request('http://localhost/api/agent', { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }));
      res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(await result.text()); return;
    }
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (!/^\/(js|css)\/[a-zA-Z0-9/_.-]+$/.test(req.url) || req.url.includes('..')) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', req.url.endsWith('.css') ? 'text/css' : 'application/javascript'); res.end(await readFile(resolve(root, '.' + req.url)));
  } catch (e) { res.writeHead(500); res.end(e.message); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForFunction(() => window.ready);
  await page.getByLabel('Your request').fill('Create a report'); await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.task-state')?.textContent === 'Completed');
  assert.equal(await page.evaluate(() => window.unsafe), undefined);
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download report.md' }).click();
  const download = await downloadPromise; assert.equal(download.suggestedFilename(), 'report.md');
  assert.match(await readFile(await download.path(), 'utf8'), /Actual file result/);
  assert.ok(await page.evaluate(async () => (await AAA_CHAT_MESSAGE_STORE.thread()).some(m => m.card?.run?.status === 'completed')), 'completed chat card persisted before reload');
  await page.reload(); await page.waitForFunction(() => window.ready);
  assert.equal(await page.getByRole('button', { name: 'Download report.md' }).count(), 1);
  await page.getByLabel('Your request').fill('Perform the external task'); await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await page.getByRole('button', { name: 'Approve action' }).waitFor(); assert.equal(externalCalls, 0);
  assert.match(await page.locator('.task-review pre').textContent(), /Review this exact title/);
  await page.getByRole('button', { name: 'Approve action' }).click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.task-state')).every(n => n.textContent === 'Completed'));
  assert.equal(externalCalls, 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.AGENT_SCREENSHOT) await page.screenshot({ path: process.env.AGENT_SCREENSHOT, fullPage: true });
  await page.evaluate(() => AAA_OFFLINE_CHAT_QUEUE.setOnline(false));
  await page.getByLabel('Your request').fill('Queue this report'); await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await page.getByRole('button', { name: 'Send queued messages' }).waitFor();
  const taskId = await page.evaluate(async () => (await AAA_OFFLINE_CHAT_QUEUE.pending())[0].opts.taskId); assert.ok(taskId);
  await page.evaluate(() => AAA_OFFLINE_CHAT_QUEUE.setOnline(true)); await page.getByRole('button', { name: 'Send queued messages' }).click();
  await page.waitForFunction(() => document.querySelector('.task-status').textContent.includes('messages sent.'));
  await page.waitForFunction(async () => !(await AAA_OFFLINE_CHAT_QUEUE.pending()).length);
  const records = await page.evaluate(() => AAA_DATA.list('agent_runs')); assert.equal(records.filter(r => r.id === taskId).length, 1, JSON.stringify({ taskId, ids: records.map(r => r.id), status: await page.locator('.task-status').textContent() }));
  assert.deepEqual(errors, []);
  console.log('Mobile browser checks passed: real task loop, review/execute, download, reload, XSS escaping, offline replay and 393px layout. Provider responses were fixtures.');
} finally { await browser.close(); await new Promise(r => server.close(r)); }
