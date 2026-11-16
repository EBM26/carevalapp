// auth.js — password check and signed session tokens. Pure WebCrypto, no I/O,
// so it runs in Pages Functions and in the test suite. Holds no secrets: the
// secrets are passed in from the environment by functions/_middleware.js.
//
// Token format: "v1.<expiry unix seconds>.<base64url HMAC-SHA256>"
// The HMAC (keyed with SESSION_SECRET) covers the version, the expiry and a
// hash of the current APP_PASSWORD. So:
//   - the password is never in the cookie, and
//   - changing APP_PASSWORD (or SESSION_SECRET) logs out every session.

export const SESSION_DAYS = 30;
export const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;
export const MIN_SECRET_LENGTH = 32;

const enc = new TextEncoder();

function b64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sha256b64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

/** Returns a reason string if the secrets are missing/weak, else null. Fail closed. */
export function configError(env) {
  if (!env?.APP_PASSWORD) return 'APP_PASSWORD is not set';
  if (!env?.SESSION_SECRET) return 'SESSION_SECRET is not set';
  if (env.SESSION_SECRET.length < MIN_SECRET_LENGTH) return `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`;
  return null;
}

/**
 * Constant-time password check. Both values are first reduced to fixed-length
 * HMACs, so neither the comparison time nor an early exit on length reveals
 * anything about the real password.
 */
export async function passwordMatches(input, env) {
  const key = await hmacKey(env.SESSION_SECRET);
  const [a, b] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(`pw:${String(input ?? '')}`)),
    crypto.subtle.sign('HMAC', key, enc.encode(`pw:${env.APP_PASSWORD}`)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function signedMessage(exp, env) {
  return enc.encode(`v1.${exp}.${await sha256b64(env.APP_PASSWORD)}`);
}

/** New session token valid for SESSION_DAYS from `nowSec`. */
export async function createSession(env, nowSec = Math.floor(Date.now() / 1000)) {
  const exp = nowSec + SESSION_SECONDS;
  const key = await hmacKey(env.SESSION_SECRET);
  const sig = await crypto.subtle.sign('HMAC', key, await signedMessage(exp, env));
  return `v1.${exp}.${b64url(sig)}`;
}

/** True if the token is well-formed, unexpired and signed for the current secrets. */
export async function verifySession(token, env, nowSec = Math.floor(Date.now() / 1000)) {
  const m = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp <= nowSec || exp > nowSec + SESSION_SECONDS + 60) return false;
  let sig;
  try { sig = fromB64url(m[2]); } catch { return false; }
  const key = await hmacKey(env.SESSION_SECRET);
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC', key, sig, await signedMessage(exp, env));
}
