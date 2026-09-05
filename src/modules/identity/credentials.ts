import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { Algorithm, hash, verify } from '@node-rs/argon2';
import { generate, generateSecret, generateURI, verify as verifyTotp } from 'otplib';

import { config } from '../../shared/config';

/**
 * Everything secret in the identity module: password hashing, TOTP secrets and
 * session tokens. Isolated here so there is exactly one place to audit, and so
 * no service accidentally reaches for `crypto` directly.
 */

// ------------------------------------------------------------------ passwords

/**
 * argon2id, as the schema comment requires (database design Part 4.1).
 * Parameters follow the OWASP baseline: 19 MiB, two passes. The cost is per
 * login attempt, which is the point — it is what makes an offline attack on a
 * leaked hash expensive.
 */
const ARGON2 = { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2);
}

export function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  return verify(storedHash, plain, ARGON2);
}

/**
 * A password the driver can type from an email. Twelve characters of a
 * no-lookalike alphabet, grouped so it is copyable. Login policy is length
 * only, so this is enough.
 */
export function generateLoginPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const raw = Array.from(randomBytes(12), (byte) => alphabet[byte % alphabet.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

/**
 * A wrong email and a wrong password must cost the same. Without this, the
 * response time alone tells an attacker which addresses are registered, so an
 * unknown email is verified against a real hash of a value nobody knows.
 */
const DUMMY_HASH_PROMISE = hashPassword(randomBytes(32).toString('hex'));

export async function burnPasswordTime(plain: string): Promise<void> {
  await verify(await DUMMY_HASH_PROMISE, plain, ARGON2).catch(() => false);
}

// ----------------------------------------------------------------------- TOTP

export interface TotpEnrolment {
  secret: string;
  otpauthUri: string;
}

export function createTotpEnrolment(email: string): TotpEnrolment {
  const secret = generateSecret();
  return {
    secret,
    otpauthUri: generateURI({ secret, label: email, issuer: config.totp.issuer }),
  };
}

export async function checkTotp(secret: string, token: string): Promise<boolean> {
  // One step of tolerance either side: thirty seconds of clock drift between a
  // phone and the server is ordinary, and rejecting it reads to the user as a
  // broken authenticator rather than as a security control.
  const result = await verifyTotp({ secret, token, epochTolerance: 1 });
  return result.valid;
}

/** Development helper — the current code for a secret. Never called at runtime. */
export function currentTotp(secret: string): Promise<string> {
  return generate({ secret });
}

// ------------------------------------------------------- TOTP secret at rest

/**
 * AES-256-GCM. The design calls for envelope encryption via KMS; this is the
 * same shape with the key held in configuration instead, so moving to KMS
 * later replaces `key()` and nothing else.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;

function key(): Buffer {
  return createHash('sha256').update(config.totp.encryptionKey).digest();
}

export function encryptSecret(plain: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decryptSecret(payload: Buffer): string {
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = payload.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

// ------------------------------------------------------------- session tokens

/**
 * 256 bits of randomness. The cookie carries the token; the database stores
 * only its digest, so a dump of `user_sessions` cannot be replayed. SHA-256 is
 * enough here where argon2 is needed for passwords — this input is already
 * high-entropy, so there is nothing to brute-force.
 */
export function createSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
