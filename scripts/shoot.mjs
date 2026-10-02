// Screenshots at 360, 768, 1280 and 1920 in light and dark, with an overflow check. Usage: node scripts/shoot.mjs r1 [baseUrl] [--only=home,result]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const round = process.argv[2] ?? 'r1';
const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:15742';
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').replace('--only=', '').split(',').filter(Boolean);
const out = path.join(process.cwd(), 'shots', round);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/home/rogerkorantenng/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] });
const widths = [360, 768, 1280, 1920];
const report = [];
for (const scheme of ['light', 'dark']) {
  for (const w of widths) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const snap = async (name, full = true) => {
      if (only.length && !only.includes(name)) return;
      await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(250);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.screenshot({ path: path.join(out, `${name}-${w}-${scheme}.png`), fullPage: full });
      report.push({ name, w, scheme, overflow });
    };
    await page.goto(base + '/#/check', { waitUntil: 'networkidle' });
    await snap('home');
    await page.getByRole('button', { name: 'Retried payout' }).click();
    await page.getByRole('heading', { level: 2, name: /This call|No known/ }).waitFor({ timeout: 20000 });
    await snap('result');
    for (const [id, wait] of [['traps', 'Known traps'], ['examples', 'Worked examples'], ['sources', 'Where PayPal'], ['method', 'How this was built']]) {
      await page.goto(`${base}/#/${id}`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { level: 1, name: new RegExp(wait) }).waitFor({ timeout: 30000 });
      if (id === 'sources') await page.getByText('Live schema, GitHub mirror').waitFor({ timeout: 40000 }).catch(() => {});
      await snap(id);
    }
    if (errors.length) report.push({ w, scheme, errors });
    await ctx.close();
  }
}
await browser.close();
const bad = report.filter((r) => r.overflow > 0 || r.errors);
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
console.log(`${report.length} captures in ${out}; ${bad.length} with horizontal overflow or console errors`);
for (const b of bad) console.log(JSON.stringify(b));
