/**
 * Firebase token claim validation.
 *
 * These use REAL RS256 signing with a locally generated key pair, so the
 * signature path is genuinely exercised rather than stubbed. No real Firebase
 * token is used, printed or stored anywhere.
 *
 * One test per item in the staging audit checklist:
 *   signature · algorithm · issuer · audience · expiry · issued-at ·
 *   auth_time · subject · cross-project rejection
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, exportJWK, type JWK } from 'jose';
import { claimsToIdentity } from '../src/auth/firebase.js';
import { jwtVerify, createLocalJWKSet } from 'jose';

const PROJECT = 'life-os-test-project';
const OTHER_PROJECT = 'someone-elses-project';
const nowSec = () => Math.floor(Date.now() / 1000);

/** A payload that passes every check, so each test can break exactly one thing. */
const goodClaims = (over: Record<string, unknown> = {}) => ({
  aud: PROJECT,
  iss: `https://securetoken.google.com/${PROJECT}`,
  sub: 'firebase-uid-abc123',
  email: 'person@example.com',
  name: 'A Person',
  iat: nowSec() - 30,
  auth_time: nowSec() - 60,
  exp: nowSec() + 3600,
  ...over,
});

const rejects = (claims: Record<string, unknown>, because: string) => {
  assert.throws(() => claimsToIdentity(claims as any, PROJECT), /./, because);
};

test('claims: a well-formed token yields the identity, and ONLY from the token', () => {
  const id = claimsToIdentity(goodClaims() as any, PROJECT);
  assert.equal(id.externalUid, 'firebase-uid-abc123');   // from `sub`
  assert.equal(id.email, 'person@example.com');
  assert.equal(id.displayName, 'A Person');
  // There is no path for a caller to influence these other than by holding a
  // validly signed token. Routes never read a uid from params, query or body.
});

test('claims: audience must equal the intended Firebase project', () => {
  rejects(goodClaims({ aud: OTHER_PROJECT }), 'wrong audience accepted');
  rejects(goodClaims({ aud: undefined }), 'missing audience accepted');
  rejects(goodClaims({ aud: [PROJECT] }), 'array audience accepted');
});

test('claims: issuer must be the Firebase issuer for THIS project', () => {
  rejects(goodClaims({ iss: `https://securetoken.google.com/${OTHER_PROJECT}` }), 'wrong issuer accepted');
  rejects(goodClaims({ iss: 'https://evil.example.com/' }), 'foreign issuer accepted');
  rejects(goodClaims({ iss: undefined }), 'missing issuer accepted');
});

test('claims: a token from an unintended Firebase project is refused', () => {
  // The realistic cross-project attack: a real, validly-signed Google token
  // from a DIFFERENT Firebase project. Google signs every project with the
  // same keys, so the signature alone would pass — aud and iss are what stop it.
  const foreign = {
    aud: OTHER_PROJECT,
    iss: `https://securetoken.google.com/${OTHER_PROJECT}`,
    sub: 'uid-from-elsewhere', email: 'attacker@example.com',
    iat: nowSec() - 10, auth_time: nowSec() - 10, exp: nowSec() + 3600,
  };
  rejects(foreign, 'a token from another Firebase project was accepted');
});

test('claims: expiry must be present', () => {
  // jwtVerify enforces exp when it exists; this guards the token that has none,
  // which would otherwise behave as a token that never expires.
  rejects(goodClaims({ exp: undefined }), 'token without exp accepted');
  rejects(goodClaims({ exp: 'soon' }), 'non-numeric exp accepted');
});

test('claims: issued-at must be present and not in the future', () => {
  rejects(goodClaims({ iat: undefined }), 'missing iat accepted');
  rejects(goodClaims({ iat: nowSec() + 3600 }), 'future iat accepted');
  // Small skew is tolerated on purpose — clocks disagree.
  assert.doesNotThrow(() => claimsToIdentity(goodClaims({ iat: nowSec() + 20 }) as any, PROJECT));
});

test('claims: auth_time must be present and not in the future', () => {
  rejects(goodClaims({ auth_time: undefined }), 'missing auth_time accepted');
  rejects(goodClaims({ auth_time: nowSec() + 3600 }), 'future auth_time accepted');
  assert.doesNotThrow(() => claimsToIdentity(goodClaims({ auth_time: nowSec() + 20 }) as any, PROJECT));
});

test('claims: subject must exist and be a non-empty string', () => {
  rejects(goodClaims({ sub: undefined }), 'missing sub accepted');
  rejects(goodClaims({ sub: '' }), 'empty sub accepted');
  rejects(goodClaims({ sub: 12345 }), 'numeric sub accepted');
});

test('claims: an email is required (anonymous and phone sign-in are not supported)', () => {
  rejects(goodClaims({ email: undefined }), 'token with no email accepted');
  rejects(goodClaims({ email: '' }), 'empty email accepted');
});

test('claims: a missing display name is allowed and becomes null', () => {
  assert.equal(claimsToIdentity(goodClaims({ name: undefined }) as any, PROJECT).displayName, null);
});

/* ── Signature and algorithm, with real crypto ───────────────────────── */

async function signedWith(alg: string, claims: Record<string, unknown>) {
  const { privateKey, publicKey } = await generateKeyPair(alg);
  const jwk = await exportJWK(publicKey);
  jwk.alg = alg; jwk.kid = 'test-key';
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg, kid: 'test-key' })
    .sign(privateKey);
  return { token, jwks: createLocalJWKSet({ keys: [jwk as JWK] }) };
}

/** Mirrors the options in verifyIdentityToken. */
const verifyOpts = {
  issuer: `https://securetoken.google.com/${PROJECT}`,
  audience: PROJECT,
  algorithms: ['RS256'] as string[],
  clockTolerance: 60,
};

test('signature: a token signed by the right key verifies', async () => {
  const { token, jwks } = await signedWith('RS256', goodClaims());
  const { payload } = await jwtVerify(token, jwks, verifyOpts);
  assert.equal(claimsToIdentity(payload, PROJECT).externalUid, 'firebase-uid-abc123');
});

test('signature: a token signed by a DIFFERENT key is rejected', async () => {
  const { token } = await signedWith('RS256', goodClaims());
  const other = await signedWith('RS256', goodClaims());   // unrelated key set
  await assert.rejects(() => jwtVerify(token, other.jwks, verifyOpts),
    'a token signed by an unrelated key verified');
});

test('signature: a tampered payload is rejected', async () => {
  const { token, jwks } = await signedWith('RS256', goodClaims());
  const [h, p, s] = token.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  claims.sub = 'someone-else';                       // escalate to another user
  const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
  await assert.rejects(() => jwtVerify(forged, jwks, verifyOpts), 'tampered payload verified');
});

test('algorithm: only RS256 is accepted', async () => {
  // ES256 is a perfectly good algorithm — the point is that the pin refuses
  // anything Firebase does not use, so algorithm confusion has no surface.
  const { token, jwks } = await signedWith('ES256', goodClaims());
  await assert.rejects(() => jwtVerify(token, jwks, verifyOpts), 'a non-RS256 token verified');
});

test('expiry: an expired token is rejected by the verifier itself', async () => {
  const { token, jwks } = await signedWith('RS256',
    goodClaims({ exp: nowSec() - 3600, iat: nowSec() - 7200, auth_time: nowSec() - 7200 }));
  await assert.rejects(() => jwtVerify(token, jwks, verifyOpts), 'an expired token verified');
});
