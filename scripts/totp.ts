import { currentTotp } from '../src/modules/identity/credentials';

/**
 * Prints the current TOTP code for a secret.
 *
 * Purely a manual-testing convenience. A tester working through the API by hand
 * needs a fresh six digits every thirty seconds, and retyping them off a phone
 * turns a two-minute test run into a ten-minute one.
 *
 *   npm run totp -- <secret from POST /v1/auth/mfa/enrol>
 *   npm run totp -- <secret> --watch
 *
 * The phone is still worth using once, to prove the otpauth URI scans and that
 * a real authenticator agrees with the server.
 */

/** otplib rejects anything shorter, and its own error is a bare stack trace. */
const MIN_SECRET_BYTES = 16;
const MIN_BASE32_CHARS = Math.ceil((MIN_SECRET_BYTES * 8) / 5);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const secret = args.find((arg) => !arg.startsWith('--'));
  const watch = args.includes('--watch');

  if (!secret) {
    console.error('Usage: npm run totp -- <base32-secret> [--watch]');
    console.error('The secret is the one returned by POST /v1/auth/mfa/enrol.');
    process.exit(1);
  }

  // A truncated copy-paste is the likely cause, and it is worth saying so —
  // the library's own failure is a stack trace about byte counts.
  if (secret.length < MIN_BASE32_CHARS) {
    console.error(
      `That secret is ${String(secret.length)} characters; a real one is at least ` +
        `${String(MIN_BASE32_CHARS)}. Check it was copied in full.`,
    );
    process.exit(1);
  }

  if (!watch) {
    console.log(await currentTotp(secret));
    return;
  }

  console.log('Ctrl-C to stop.\n');
  for (;;) {
    // TOTP windows are thirty seconds wide and aligned to the epoch, so this
    // reports how long the printed code remains valid rather than guessing.
    const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);
    console.log(`${await currentTotp(secret)}   valid for ${String(secondsLeft)}s`);
    await new Promise((resolve) => setTimeout(resolve, secondsLeft * 1000));
  }
}

void main();
