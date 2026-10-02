// Sandbox access. The secret lives in the Lambda environment; nothing here is ever returned to a browser.
const API = (env = process.env) => (env.PAYPAL_API || 'https://api-m.sandbox.paypal.com').replace(/\/$/, '');
export const SANDBOX_API = 'https://api-m.sandbox.paypal.com';

export class PayPalError extends Error {
  constructor(message, { status, body } = {}) { super(message); this.name = 'PayPalError'; this.status = status; this.body = body; }
}

let cached = { token: null, exp: 0 };

export function resetToken() { cached = { token: null, exp: 0 }; }

export async function getToken(env = process.env, fetchImpl = fetch) {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const id = env.PAYPAL_CLIENT_ID; const secret = env.PAYPAL_SECRET;
  if (!id || !secret) throw new PayPalError('PayPal sandbox credentials are not configured on this deployment.');
  if (!/sandbox/.test(API(env))) throw new PayPalError('Refusing to use a PayPal host that is not the sandbox.');
  const r = await fetchImpl(`${API(env)}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new PayPalError(`PayPal refused the sandbox credentials (${r.status}).`, { status: r.status, body: j });
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3000) * 1000 };
  return cached.token;
}

/** One sandbox call. Never throws on a non-2xx: the status is the data. */
export async function call({ method, path, query, headers = {}, body, env = process.env, fetchImpl = fetch, timeoutMs = 25000 }) {
  const token = await getToken(env, fetchImpl);
  const q = query && Object.keys(query).length ? '?' + Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
  const h = { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers };
  let payload;
  if (body !== undefined) { h['Content-Type'] ??= 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
  const t0 = Date.now();
  const r = await fetchImpl(`${API(env)}${path}${q}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let json = null;
  const ct = r.headers.get('content-type') ?? '';
  if (/json/.test(ct) || /^\s*[{[]/.test(text)) { try { json = text ? JSON.parse(text) : null; } catch { json = null; } }
  return { status: r.status, body: json ?? (text ? text.slice(0, 400) : null), ms: Date.now() - t0, debugId: r.headers.get('paypal-debug-id') };
}
