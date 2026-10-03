// PayPal webhook authentication. Two independent verifiers:
//  * verifyLocal  - recompute the CRC32 of the raw body, rebuild "transmissionId|time|webhookId|crc32", check the
//                   RSA-SHA256 signature against the certificate named in PAYPAL-CERT-URL. The cert URL must be https on
//                   paypal.com: PayPal's own sample code skips that check, which lets anyone sign with their own cert.
//  * verifyViaApi - POST /v1/notifications/verify-webhook-signature, PayPal's postback check.
// The same checks are applied to every webhook this service accepts.
import crypto from 'node:crypto';
import { call } from './paypal.js';

const REQUIRED = ['paypal-transmission-id', 'paypal-transmission-time', 'paypal-transmission-sig', 'paypal-cert-url', 'paypal-auth-algo'];

export const lowerHeaders = (h) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
export const missingHeaders = (h) => REQUIRED.filter((k) => !h[k]);

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of Buffer.from(buf)) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function certUrlAllowed(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)paypal\.com$/.test(x.hostname); } catch { return false; }
}

export const signedString = (h, rawBody, webhookId) => `${h['paypal-transmission-id']}|${h['paypal-transmission-time']}|${webhookId}|${crc32(rawBody)}`;

const certCache = new Map();
export async function fetchCertKey(url) {
  if (certCache.has(url)) return certCache.get(url);
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const x = new crypto.X509Certificate(await r.text());
  if (new Date(x.validTo) < new Date()) throw new Error('certificate expired');
  certCache.set(url, x.publicKey);
  return x.publicKey;
}

let defaultGetKey = fetchCertKey;
export function setCertKeyGetter(fn) { defaultGetKey = fn ?? fetchCertKey; }

/** @param getKey async (certUrl) => KeyObject. Injectable so tests need no network. */
export async function verifyLocal({ headers, rawBody, webhookId, getKey = defaultGetKey, now = Date.now(), maxSkewMs = 60 * 60_000 }) {
  const h = lowerHeaders(headers);
  const miss = missingHeaders(h);
  if (miss.length) return { ok: false, reason: `missing headers: ${miss.join(', ')}` };
  if (!webhookId) return { ok: false, reason: 'webhook id not configured' };
  if (!certUrlAllowed(h['paypal-cert-url'])) return { ok: false, reason: 'certificate URL is not https on paypal.com' };
  const t = Date.parse(h['paypal-transmission-time']);
  if (!Number.isFinite(t) || Math.abs(now - t) > maxSkewMs) return { ok: false, reason: 'transmission time is outside the allowed window (replay protection)' };
  const algo = { SHA256withRSA: 'RSA-SHA256' }[h['paypal-auth-algo']];
  if (!algo) return { ok: false, reason: `unsupported auth algorithm ${h['paypal-auth-algo']}` };
  let key;
  try { key = await getKey(h['paypal-cert-url']); } catch (e) { return { ok: false, reason: 'certificate could not be fetched: ' + e.message, transient: true }; }
  let ok = false;
  try { ok = crypto.createVerify(algo).update(signedString(h, rawBody, webhookId)).verify(key, Buffer.from(h['paypal-transmission-sig'], 'base64')); } catch { ok = false; }
  return ok ? { ok: true, via: 'local' } : { ok: false, reason: 'signature does not match the payload' };
}

export async function verifyViaApi({ headers, rawBody, webhookId, env = process.env, fetchImpl = fetch }) {
  const h = lowerHeaders(headers);
  const miss = missingHeaders(h);
  if (miss.length) return { ok: false, reason: `missing headers: ${miss.join(', ')}` };
  if (!webhookId) return { ok: false, reason: 'webhook id not configured' };
  let event; try { event = JSON.parse(rawBody); } catch { return { ok: false, reason: 'body is not JSON' }; }
  const r = await call({ method: 'POST', path: '/v1/notifications/verify-webhook-signature', body: { auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'], transmission_id: h['paypal-transmission-id'], transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'], webhook_id: webhookId, webhook_event: event }, env, fetchImpl });
  if (r.status >= 300) return { ok: false, reason: `PayPal verification call failed (${r.status})`, transient: r.status >= 500 };
  return r.body?.verification_status === 'SUCCESS' ? { ok: true, via: 'paypal-api' } : { ok: false, reason: `PayPal verification_status ${r.body?.verification_status}`, via: 'paypal-api' };
}

/** Local first (no round trip to PayPal while PayPal waits); fall back to the postback if the cert cannot be fetched. */
export async function verify(args) {
  const local = await verifyLocal(args);
  if (local.ok || !local.transient) return local;
  return verifyViaApi(args);
}

/** Pull the resource ids an event refers to, so it can be tied to a run. */
export function resourceIds(event) {
  const r = event?.resource ?? {}; const ids = new Set();
  for (const v of [r.payout_batch_id, r.batch_header?.payout_batch_id, r.payout_item_id, r.id, r.invoice?.id, r.supplementary_data?.related_ids?.order_id, r.parent_payment]) if (typeof v === 'string') ids.add(v);
  return [...ids];
}
