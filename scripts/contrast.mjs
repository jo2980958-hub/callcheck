// WCAG contrast from the real tokens in frontend/src/styles.css. Text needs 4.5:1 (the 3:1 large-text allowance is never relied on);
// borders and icons that carry meaning need 3:1. Prints a markdown table when run with --md.
import fs from 'node:fs';
const css = fs.readFileSync(new URL('../frontend/src/styles.css', import.meta.url), 'utf8');
const block = (re) => { const m = re.exec(css); return Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((x) => [x[1], x[2]])); };
const light = block(/\n:root \{([\s\S]*?)\n\}/);
const dark = block(/:root\[data-theme='dark'\] \{([\s\S]*?)\n\}/);
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const rows = [];
for (const [theme, t] of [['light', light], ['dark', dark]]) {
  const T = (name, fg, bg, need = 4.5) => rows.push({ theme, name, fg: t[fg], bg: t[bg], need, r: ratio(t[fg], t[bg]) });
  for (const bg of ['bg', 'surface', 'surface2']) { T(`Body text on ${bg}`, 'text', bg); T(`Muted text on ${bg}`, 'muted', bg); T(`Link and accent text on ${bg}`, 'accent', bg); }
  T('Button label on primary button', 'accent-ink', 'accent');
  T('Selected tab text on accent tint', 'accent', 'accent-soft');
  for (const k of ['blocker', 'warn', 'ok', 'note']) { T(`${k} text on surface`, k, 'surface'); T(`${k} text on page`, k, 'bg'); T(`${k} text on its tint`, k, `${k === 'warn' ? 'warn' : k}-bg`); T(`Body text on ${k} tint`, 'text', `${k}-bg`); }
  T('Primary text in code block', 'text', 'code-bg'); T('Placeholder (muted) on code block', 'muted', 'code-bg');
  for (const tk of ['key', 'str', 'num', 'lit', 'kw', 'verb', 'url', 'hdr', 'flag', 'com', 'pun', 'id']) { T(`Syntax ${tk} on code block`, `tk-${tk}`, 'code-bg'); T(`Syntax ${tk} on added line`, `tk-${tk}`, 'add-bg'); T(`Syntax ${tk} on removed line`, `tk-${tk}`, 'del-bg'); T(`Syntax ${tk} on code bar (surface2)`, `tk-${tk}`, 'surface2'); }
  T('Diff plus mark on added line', 'ok', 'add-bg'); T('Diff minus mark on removed line', 'blocker', 'del-bg');
  T('Input border against surface (UI, 3:1)', 'control', 'surface', 3); T('Input border against code block (UI, 3:1)', 'control', 'code-bg', 3);
  T('Focus ring against page (UI, 3:1)', 'focus', 'bg', 3); T('Focus ring against surface (UI, 3:1)', 'focus', 'surface', 3);
}
const fails = rows.filter((r) => r.r < r.need);
if (process.argv.includes('--md')) {
  console.log('| Theme | Pair | Foreground | Background | Ratio | Needs |\n|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.theme} | ${r.name} | ${r.fg} | ${r.bg} | ${r.r.toFixed(2)}:1 | ${r.need}:1 |`);
} else {
  for (const r of rows) console.log(`${r.r >= r.need ? 'PASS' : 'FAIL'}  ${r.r.toFixed(2).padStart(5)}:1  (need ${r.need})  [${r.theme}] ${r.name}  ${r.fg} on ${r.bg}`);
}
console.error(`${rows.length} pairs, ${fails.length} failing`);
process.exit(fails.length ? 1 : 0);
