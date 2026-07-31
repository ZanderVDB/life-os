/**
 * Firebase ID token verification — server-side, no service account required.
 *
 * A Firebase ID token is an RS256 JWT signed by Google. Verifying it needs only
 * Google's PUBLIC signing keys plus the project id, so this deliberately avoids
 * firebase-admin and the private-key secret it would demand. Fewer secrets,
 * fewer manual setup steps, same guarantee.
 *
 * REPLACING FIREBASE LATER: nothing outside this file knows about Firebase.
 * The rest of the system keys off the internal `users.id` UUID, with
 * `users.firebase_uid` as one nullable external-identity column. Swapping in
 * our own sessions (or Apple/email sign-in) means writing a different
 * `verifyIdentityToken` and adding an identity row — the data model is
 * untouched.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { unauthorized } from '../lib/errors.js';

const GOOGLE_JWKS_URL = new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
);

export interface VerifiedIdentity {
  externalUid: string;
  email: string;
  displayName: string | null;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  // jose caches and refreshes the key set internally.
  if (!jwks) jwks = createRemoteJWKSet(GOOGLE_JWKS_URL, { cacheMaxAge: 6 * 60 * 60 * 1000 });
  return jwks;
}

/** Exported for tests: pure claim validation, independent of network I/O. */
export function claimsToIdentity(payload: JWTPayload, projectId: string): VerifiedIdentity {
  const iss = `https://securetoken.google.com/${projectId}`;
  if (payload.aud !== projectId) throw unauthorized('Token audience mismatch.');
  if (payload.iss !== iss) throw unauthorized('Token issuer mismatch.');

  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (!sub) throw unauthorized('Token has no subject.');

  const email = typeof payload['email'] === 'string' ? payload['email'] : '';
  if (!email) throw unauthorized('Token has no email claim.');

  const name = typeof payload['name'] === 'string' ? payload['name'] : null;
  return { externalUid: sub, email, displayName: name };
}

export async function verifyIdentityToken(token: string, projectId: string): Promise<VerifiedIdentity> {
  let payload: JWTPayload;
  try {
    const res = await jwtVerify(token, getJwks(), {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ['RS256'],
    });
    payload = res.payload;
  } catch {
    // Never surface the underlying reason — it only helps an attacker.
    throw unauthorized('Invalid or expired sign-in token.');
  }
  return claimsToIdentity(payload, projectId);
}

export function bearerFrom(header: string | undefined): string {
  if (!header) throw unauthorized('Missing Authorization header.');
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m || !m[1]) throw unauthorized('Authorization header must be "Bearer <token>".');
  return m[1];
}
