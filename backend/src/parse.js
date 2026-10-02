// Turns pasted text into a normalised request. Accepts curl, a raw HTTP request, "METHOD URL" followed by JSON, and fetch().
// Credentials are redacted on the way in and never stored.
import { parseJsExpression, extractCall } from './jsliteral.js';

const PATH_PRODUCT = [
  [/^\/v2\/checkout\/orders/, 'orders'],
  [/^\/v2\/payments\//, 'payments'],
  [/^\/v1\/payments\/payouts/, 'payouts'],
  [/^\/v2\/invoicing\//, 'invoicing'],
  [/^\/v1\/billing\//, 'subscriptions'],
  [/^\/v1\/catalogs\//, 'catalog'],
  [/^\/v1\/customer\/disputes/, 'disputes'],
  [/^\/v1\/notifications\//, 'webhooks'],
  [/^\/v3\/vault\//, 'vault'],
  [/^\/v1\/reporting\//, 'transactions'],
];

export function productForPath(p) {
  for (const [re, id] of PATH_PRODUCT) if (re.test(p)) return id;
  return null;
}

/** Split a shell command into words, honouring quotes and backslash-newline continuations. */
export function shellWords(src) {
  const s = src.replace(/\\\r?\n/g, ' ');
  const out = []; let cur = ''; let q = null; let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (q === '"' && c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) { cur += s[++i]; continue; }
      cur += c; continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += c; has = true;
  }
  if (cur || has) out.push(cur);
  return out;
}

function tryJson(text) {
  if (text == null) return { value: undefined };
  const t = String(text).trim();
  if (!t) return { value: undefined };
  try { return { value: JSON.parse(t) }; } catch (e) { return { value: undefined, error: e.message, raw: t }; }
}

function splitUrl(u) {
  let url = u.trim();
  let host = null; let proto = null;
  const m = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?/.exec(url);
  let pathname; let search = '';
  if (m) { proto = m[1]; host = m[2]; pathname = m[3] || '/'; search = m[4] || ''; }
  else { const m2 = /^([^?#]*)(\?[^#]*)?/.exec(url); pathname = m2[1] || '/'; search = m2[2] || ''; if (!pathname.startsWith('/')) pathname = '/' + pathname; }
  const query = {};
  for (const part of search.replace(/^\?/, '').split('&').filter(Boolean)) {
    const [k, ...v] = part.split('=');
    try { query[decodeURIComponent(k)] = decodeURIComponent(v.join('=').replace(/\+/g, ' ')); } catch { query[k] = v.join('='); }
  }
  return { proto, host, path: pathname, query };
}

const SECRET_HEADERS = /^(authorization|proxy-authorization|paypal-auth-assertion)$/i;

function normaliseHeaders(list, notes) {
  const headers = {};
  for (const [k, v] of list) {
    if (SECRET_HEADERS.test(k)) { headers[k] = '[redacted]'; notes.hadCredentials = true; continue; }
    headers[k] = v;
  }
  return headers;
}

function build({ method, url, headers, body, notes, source }) {
  const u = splitUrl(url);
  const parsedBody = typeof body === 'string' ? tryJson(body) : { value: body };
  return {
    source, method: (method || (body !== undefined ? 'POST' : 'GET')).toUpperCase(),
    host: u.host, proto: u.proto, path: u.path, query: u.query,
    headers, body: parsedBody.value, rawBody: typeof body === 'string' ? body : undefined, bodyError: parsedBody.error,
    hadCredentials: !!notes.hadCredentials, notes: notes.list ?? [],
  };
}

export function parseCurl(text) {
  const w = shellWords(text.trim());
  if (!w.length || !/^curl(\.exe)?$/i.test(w[0])) throw new Error('Expected a command that starts with curl.');
  let method; let url; const hdr = []; let body; const notes = { list: [] };
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    const next = () => w[++i];
    if (a === '-X' || a === '--request') method = next();
    else if (a.startsWith('-X') && a.length > 2) method = a.slice(2);
    else if (a === '-H' || a === '--header') { const h = next(); const k = h.indexOf(':'); if (k > 0) hdr.push([h.slice(0, k).trim(), h.slice(k + 1).trim()]); }
    else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode'].includes(a)) { const d = next(); body = body === undefined ? d : body + d; if (a === '--data-urlencode') notes.list.push('--data-urlencode sends a form body, not JSON.'); }
    else if (a === '--json') { body = next(); hdr.push(['Content-Type', 'application/json']); }
    else if (a === '-u' || a === '--user') { next(); notes.hadCredentials = true; }
    else if (a === '--url') url = next();
    else if (a === '-G' || a === '--get') method = method || 'GET';
    else if (a.startsWith('-')) { if (['-o', '--output', '-A', '--user-agent', '-e', '--referer', '--max-time', '-m', '--connect-timeout', '-w', '--write-out', '-b', '--cookie'].includes(a)) next(); }
    else if (!url) url = a;
  }
  if (!url) throw new Error('No URL found in the curl command.');
  const headers = normaliseHeaders(hdr, notes);
  if (body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) notes.list.push('curl sends -d bodies as application/x-www-form-urlencoded unless you add -H "Content-Type: application/json".');
  const req = build({ method, url, headers, body, notes, source: 'curl' });
  req.implicitFormContentType = body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  return req;
}

export function parseHttp(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const first = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/i.exec(lines[i] ?? '');
  if (!first) throw new Error('Expected a first line like "POST /v2/checkout/orders" or "POST https://api-m.sandbox.paypal.com/v2/checkout/orders".');
  i++;
  const hdr = []; const notes = { list: [] };
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { i++; break; }
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(l);
    if (!m) break;
    hdr.push([m[1], m[2]]);
  }
  let body = lines.slice(i).join('\n').trim();
  if (!body) body = undefined;
  let url = first[2];
  const hostH = hdr.find(([k]) => k.toLowerCase() === 'host');
  if (!/^https?:/.test(url) && hostH) url = `https://${hostH[1]}${url}`;
  return build({ method: first[1], url, headers: normaliseHeaders(hdr.filter(([k]) => k.toLowerCase() !== 'host'), notes), body, notes, source: 'http' });
}

export function parseFetch(text) {
  const call = extractCall(text, /fetch/);
  if (!call) throw new Error('Expected fetch("url", { method, headers, body }).');
  const [urlArg, opts] = call.args;
  const url = typeof urlArg === 'string' ? urlArg : urlArg?.__ident ? `https://api-m.sandbox.paypal.com/<${urlArg.__ident}>` : null;
  if (!url) throw new Error('The fetch URL must be a string.');
  const notes = { list: [] };
  const hdr = Object.entries(opts?.headers ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : '[variable]']);
  let body = opts?.body;
  if (body && typeof body === 'object' && body.__call === 'JSON.stringify') body = body.args[0];
  if (body && typeof body === 'object' && body.__ident) { notes.list.push(`The body is the variable "${body.__ident}", which cannot be read here. Paste the JSON it holds.`); body = undefined; }
  const req = build({ method: opts?.method, url, headers: normaliseHeaders(hdr, notes), body, notes, source: 'fetch' });
  return req;
}

export function parseRest(text) {
  const t = text.trim();
  if (!t) throw new Error('Paste a request first.');
  if (/^curl\b/i.test(t)) return parseCurl(t);
  if (/\bfetch\s*\(/.test(t)) return parseFetch(t);
  return parseHttp(t);
}

export { parseJsExpression };
