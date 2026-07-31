/**
 * Encryption for stored OAuth tokens.
 *
 * A refresh token is a long-lived key to someone's calendar. Stored in plain
 * text it is worth more than the database row it sits in, so it is encrypted
 * at rest and never leaves the server.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than silently returning rubbish. The stored format is
 *
 *     v1.<iv-b64>.<tag-b64>.<ciphertext-b64>
 *
 * The version prefix exists so a future key rotation can be told apart from
 * old data rather than guessed at.
 *
 * KEY ROTATION — a known limitation, stated plainly. There is currently ONE
 * key. Rotating it invalidates every stored token, which forces users to
 * reconnect. That is acceptable at this stage (one user, staging) but a real
 * rotation story needs a key id in the prefix and a decrypt-with-old,
 * re-encrypt-with-new migration. Recorded in docs/technical-debt.md.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;      // GCM standard

/**
 * Derives a 32-byte key from the configured secret.
 *
 * SHA-256 rather than a KDF because the input is expected to be a
 * high-entropy generated secret, not a human password. If that ever changes,
 * this must become scrypt or argon2 — a fast hash over a guessable passphrase
 * would be the weak link.
 */
function keyFrom(secret: string): Buffer {
  if (!secret || secret.length < 32) {
    throw new Error('GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY must be at least 32 characters.');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptToken(plain: string, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptToken(stored: string, secret: string): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Stored credential is not in a recognised format.');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGO, keyFrom(secret), Buffer.from(ivB64!, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64!, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** True when a value looks like something this module produced. */
export const isEncrypted = (v: string | null | undefined): boolean =>
  typeof v === 'string' && v.startsWith(`${VERSION}.`) && v.split('.').length === 4;

/**
 * Redacts anything token-shaped before it can reach a log line.
 *
 * Belt and braces: nothing should log a token in the first place, but a single
 * careless `log.error(err)` on a Google error object would otherwise be enough
 * to put an access token in the log stream forever.
 */
export function redactTokens<T>(value: T): T {
  const SENSITIVE = /^(access_token|refresh_token|id_token|client_secret|code|token)$/i;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = SENSITIVE.test(k) ? '[redacted]' : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
