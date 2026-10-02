// Measured accessibility checks in a real browser: control sizes, visible focus on every tab stop, 200% text, reflow at 320px,
// accessible names, and no horizontal scroll. Usage: node scripts/a11y-check.mjs [baseUrl]
import { chromium } from 'playwright-core';
const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:15742';
const args = ['--no-sandbox', ...(base.includes('cloudfront') ? ['--host-resolver-rules=MAP *.cloudfront.net 18.239.15.108'] : [])];
const browser = await chromium.launch({ executablePath: '/home/rogerkorantenng/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args });
let fails = 0; const say = (ok, m) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${m}`); };
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme }); const page = await ctx.newPage();
  for (const route of ['check', 'traps', 'examples', 'sources', 'method']) {
    await page.goto(`${base}/#/${route}`, { waitUntil: 'networkidle' }); await page.waitForTimeout(route === 'sources' ? 6000 : 600);
    if (route === 'check') { await page.getByRole('button', { name: 'Retried payout' }).click(); await page.getByRole('heading', { level: 2, name: /This call/ }).waitFor(); }
    const small = await page.evaluate(() => [...document.querySelectorAll('button, a, select, input, summary, textarea')].filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && cs.visibility !== 'hidden' && !e.classList.contains('sr-only') && !e.classList.contains('skip') && (r.height < 28 || r.width < 28) && !(e.tagName === 'A' && e.closest('p, li, dd, footer') && r.height >= 18); }).map((e) => `${e.tagName}.${e.className}:${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
    say(small.length === 0, `[${scheme}] ${route}: every control is at least 28 by 28 px${small.length ? ' ... ' + small.slice(0, 4).join(', ') : ''}`);
    const names = await page.evaluate(() => [...document.querySelectorAll('button, a[href], select, input, textarea')].filter((e) => { const n = (e.getAttribute('aria-label') || e.textContent || '').trim() || (e.id && document.querySelector(`label[for="${e.id}"]`)?.textContent) || e.closest('label')?.textContent; return !(n && n.trim()); }).map((e) => e.outerHTML.slice(0, 60)));
    say(names.length === 0, `[${scheme}] ${route}: every control has an accessible name${names.length ? ' ... ' + names[0] : ''}`);
    const tiny = await page.evaluate(() => { let min = 99; document.querySelectorAll('body *').forEach((e) => { if ([...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) { const s = parseFloat(getComputedStyle(e).fontSize); if (s < min) min = s; } }); return min; });
    say(tiny >= 11, `[${scheme}] ${route}: smallest text is ${tiny.toFixed(1)} px (floor 10)`);
  }
  // keyboard: tab through the check page, every stop must show an outline
  await page.goto(`${base}/#/check`, { waitUntil: 'networkidle' });
  let bad = 0; const stops = 18;
  for (let i = 0; i < stops; i++) { await page.keyboard.press('Tab'); const o = await page.evaluate(() => { const e = document.activeElement; const cs = getComputedStyle(e); return { w: parseFloat(cs.outlineWidth), st: cs.outlineStyle, tag: e.tagName }; }); if (!(o.w >= 2 && o.st !== 'none') && o.tag !== 'BODY') bad++; }
  say(bad === 0, `[${scheme}] check: ${stops} keyboard tab stops all show a 2 px focus outline`);
  await ctx.close();
}
for (const [label, w, css] of [['200% text at 1280', 1280, 'html{font-size:200%}'], ['200% text at 360', 360, 'html{font-size:200%}'], ['reflow at 320', 320, '']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } }); const page = await ctx.newPage();
  for (const route of ['check', 'traps', 'examples', 'method']) {
    await page.goto(`${base}/#/${route}`, { waitUntil: 'networkidle' }); if (css) await page.addStyleTag({ content: css });
    if (route === 'check') { await page.getByRole('button', { name: 'Retried payout' }).click(); await page.getByRole('heading', { level: 2, name: /This call/ }).waitFor(); }
    await page.waitForTimeout(500);
    const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    say(o <= 0, `${label}: ${route} has no horizontal page scroll (overflow ${o}px)`);
  }
  await ctx.close();
}
await browser.close();
console.log(`${fails} failing`); process.exit(fails ? 1 : 0);
