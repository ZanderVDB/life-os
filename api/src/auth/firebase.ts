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

/**
 * Small tolerance for clock skew between Google's servers and ours. Without it
 * a token minted a fraction of a second ago can look as though it comes from
 * the future and be rejected.
 */
const CLOCK_TOLERANCE_SECONDS = 60;

/**
 * Exported for tests: pure claim validation, independent of network I/O.
 *
 * Signature, algorithm, `exp`, `iss` and `aud` are enforced by jwtVerify before
 * this runs. `iss`/`aud` are re-checked here so the pure function is safe to
 * call on its own and so a future change to the jwtVerify options cannot
 * silently drop the project binding.
 *
 * `iat` and `auth_time` are checked HERE because jose does not validate either
 * by default, yet Firebase's own token spec requires both to be in the past.
 */
export function claimsToIdentity(payload: JWTPayload, projectId: string): VerifiedIdentity {
  const iss = `https://securetoken.google.com/${projectId}`;
  // Binds the token to one Firebase project. A validly-signed token from a
  // DIFFERENT project fails here — Google signs all projects with the same keys,
  // so this pair of checks, not the signature, is what stops cross-project use.
  if (payload.aud !== projectId) throw unauthorized('Token audience mismatch.');
  if (payload.iss !== iss) throw unauthorized('Token issuer mismatch.');

  const nowSec = Math.floor(Date.now() / 1000) + CLOCK_TOLERANCE_SECONDS;

  // exp is enforced by jwtVerify, but require it to be PRESENT: a token with no
  // expiry would otherwise sail through as one that never expires.
  if (typeof payload.exp !== 'number') throw unauthorized('Token has no expiry.');

  if (typeof payload.iat !== 'number') throw unauthorized('Token has no issued-at claim.');
  if (payload.iat > nowSec) throw unauthorized('Token was issued in the future.');

  // auth_time is when the user actually authenticated. Firebase requires it to
  // be in the past; a future value indicates a forged or tampered token.
  const authTime = payload['auth_time'];
  if (typeof authTime !== 'number') throw unauthorized('Token has no auth_time claim.');
  if (authTime > nowSec) throw unauthorized('Token auth_time is in the future.');

  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (!sub) throw unauthorized('Token has no subject.');

  // Google sign-in always carries an email. Anonymous and phone sign-in do not,
  // and are deliberately not supported — an account with no email cannot be
  // recovered or recognised across identity providers later.
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
      // Pinned. Without this an attacker could present an "alg": "none" token,
      // or one signed with a symmetric algorithm using a public key as the
      // secret. Never widen this list.
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
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
