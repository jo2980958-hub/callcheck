import { setFetch, clearSpecCache } from '../src/spec.js';
process.env.SPEC_NO_TMP = '1';
/** Offline mode: the live host is "unreachable", so specs come from the bundled snapshot and are labelled so. */
export function offline() { setFetch(async () => { throw new Error('offline test'); }); clearSpecCache(); }
export const ENV = { senderEmail: 'sb-mixsn53098231@business.example.com', registered: ['sb-patient@personal.example.com'] };
