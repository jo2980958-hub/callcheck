// A small syntax highlighter for the three things Callcheck shows: HTTP requests, JSON, and JavaScript or shell snippets.
// It only produces token spans. Colours live in styles.css, where each one is checked against the code background.
const KEYWORDS = new Set(['const', 'let', 'var', 'await', 'async', 'new', 'return', 'import', 'from', 'export', 'function', 'curl', 'npx']);
const LITERALS = new Set(['true', 'false', 'null', 'undefined']);
const VERBS = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/;

export function tokenize(src) {
  const out = []; const lines = src.split('\n');
  let inBody = false;
  lines.forEach((line, li) => {
    if (li) out.push({ t: 'ws', v: '\n' });
    let rest = line;
    if (!inBody && li === 0) {
      const m = VERBS.exec(rest);
      if (m) { out.push({ t: 'verb', v: m[0] }); rest = rest.slice(m[0].length); const sp = /^\s+/.exec(rest); if (sp) { out.push({ t: 'ws', v: sp[0] }); rest = rest.slice(sp[0].length); } const url = /^\S+/.exec(rest); if (url) { out.push({ t: 'url', v: url[0] }); rest = rest.slice(url[0].length); } }
    } else if (!inBody && /^\s*$/.test(line)) { inBody = true; }
    else if (!inBody) {
      const h = /^([A-Za-z][A-Za-z0-9-]*)(:\s*)(.*)$/.exec(line);
      if (h && !/^(const|let|var)$/.test(h[1])) { out.push({ t: 'hdr', v: h[1] }, { t: 'pun', v: h[2] }, { t: 'str', v: h[3] }); rest = ''; }
    }
    scan(rest, out);
  });
  return out;
}

function scan(s, out) {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { const m = /^\s+/.exec(s.slice(i)); out.push({ t: 'ws', v: m[0] }); i += m[0].length; continue; }
    if (c === '/' && s[i + 1] === '/') { out.push({ t: 'com', v: s.slice(i) }); return; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) { out.push({ t: 'com', v: s.slice(i) }); return; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1; while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; j++; }
      const str = s.slice(i, j + 1); const after = s.slice(j + 1);
      out.push({ t: /^\s*:/.test(after) ? 'key' : 'str', v: str }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(s[i + 1] ?? '') && !/[\w]/.test(s[i - 1] ?? ''))) { const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i)); out.push({ t: 'num', v: m[0] }); i += m[0].length; continue; }
    if (c === '-' && s[i + 1] === '-' && /[a-z]/i.test(s[i + 2] ?? '')) { const m = /^--[\w-]+/.exec(s.slice(i)); out.push({ t: 'flag', v: m[0] }); i += m[0].length; continue; }
    if (c === '-' && /[A-Za-z]/.test(s[i + 1] ?? '') && /\s/.test(s[i - 1] ?? ' ')) { const m = /^-[A-Za-z]/.exec(s.slice(i)); out.push({ t: 'flag', v: m[0] }); i += 2; continue; }
    if (/[A-Za-z_$@]/.test(c)) {
      const m = /^[@A-Za-z_$][\w$.\-/:@]*/.exec(s.slice(i)); const w = m[0];
      if (/^https?:/.test(w)) { const u = /^\S+/.exec(s.slice(i))[0]; out.push({ t: 'url', v: u }); i += u.length; continue; }
      const bare = w.replace(/[.:\-/].*$/, '');
      if (LITERALS.has(w)) out.push({ t: 'lit', v: w });
      else if (KEYWORDS.has(w)) out.push({ t: 'kw', v: w });
      else if (/^\s*:/.test(s.slice(i + w.length)) && !/[.\/]/.test(w)) out.push({ t: 'key', v: w });
      else out.push({ t: 'id', v: w });
      i += w.length; void bare; continue;
    }
    out.push({ t: 'pun', v: c }); i++;
  }
}
