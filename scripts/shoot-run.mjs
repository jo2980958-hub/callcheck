// Drives the real UI through check, sandbox run and agent explanation, and screenshots each state. Usage: node scripts/shoot-run.mjs r3 [baseUrl]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const round = process.argv[2] ?? 'r3';
const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:15742';
const out = path.join(process.cwd(), 'shots', round); fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/home/rogerkorantenng/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'], ...(base.includes('cloudfront') ? { args: ['--no-sandbox', '--host-resolver-rules=MAP *.cloudfront.net 18.239.15.108'] } : {}) });
for (const scheme of (process.env.SCHEMES ?? 'light,dark').split(',')) for (const w of (process.env.WIDTHS ?? '360,1280').split(',').map(Number)) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, colorScheme: scheme }); const page = await ctx.newPage();
  const shot = async (n, sel) => { const ov = await page.evaluate(() => { const bad = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && getComputedStyle(e).position !== 'fixed').slice(0, 4).map((e) => e.tagName + '.' + e.className); const pr = document.querySelector('.agent, .run')?.getBoundingClientRect(); return { panelRight: pr && Math.round(pr.right), over: document.documentElement.scrollWidth - document.documentElement.clientWidth, bad }; }); console.log(n, w, scheme, JSON.stringify(ov)); await page.waitForTimeout(300); if (sel) await page.locator(sel).first().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out, `${n}-${w}-${scheme}.png`), fullPage: false }); };
  await page.goto(base + '/#/check', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Retried payout' }).click();
  await page.getByRole('heading', { level: 2, name: /This call/ }).waitFor();
  await page.getByRole('button', { name: 'Run in the sandbox' }).click();
  await page.getByText('Prediction held').first().waitFor({ timeout: 90000 });
  await shot('run', '.run');
  await page.getByRole('button', { name: /Explain and correct/ }).click();
  await page.getByText(/Written by/).waitFor({ timeout: 120000 });
  await shot('agent', '.agent');
  await ctx.close();
}
await browser.close(); console.log('done', out);
