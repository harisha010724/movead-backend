import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import { buildOpenApiDocument } from '../src/contracts';

/**
 * Writes `openapi/openapi.json`, or with `--check` verifies the committed file
 * matches the schemas.
 *
 * CI runs the check. A stale document means the mobile and web clients are
 * generated from a contract the server no longer honours, and that is a build
 * failure rather than a warning (architecture Part 3.4).
 */

const target = resolve(__dirname, '../openapi/openapi.json');
const checkOnly = process.argv.includes('--check');

async function main(): Promise<void> {
  const document = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;

  if (checkOnly) {
    const committed = await readFile(target, 'utf8').catch(() => null);

    if (committed === null) {
      fail('openapi/openapi.json is missing. Run `npm run openapi:generate`.');
    }
    if (committed !== document) {
      fail('openapi/openapi.json is stale. Run `npm run openapi:generate` and commit the result.');
    }

    console.log('openapi.json is up to date.');
    return;
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, document, 'utf8');

  const paths = Object.keys(buildOpenApiDocument().paths ?? {}).length;
  console.log(`Wrote openapi/openapi.json (${String(paths)} paths).`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
