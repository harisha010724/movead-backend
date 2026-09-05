import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BadRequestError } from '../../shared/errors';

import { type ObjectStore, type StoredObject } from './storage';

/**
 * Disk-backed store. Keys must be `{owner}/{file}` with no `..` segments, so a
 * crafted key cannot walk out of the root directory.
 */
export class LocalObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
    await writeFile(`${dest}.meta`, JSON.stringify({ contentType }), 'utf8');
  }

  async get(key: string): Promise<StoredObject | null> {
    const dest = this.resolve(key);
    try {
      const [bytes, metaRaw] = await Promise.all([
        readFile(dest),
        readFile(`${dest}.meta`, 'utf8'),
      ]);
      const meta = JSON.parse(metaRaw) as { contentType?: string };
      return { bytes, contentType: meta.contentType ?? 'application/octet-stream' };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private resolve(key: string): string {
    const normalised = key.replace(/\\/g, '/');
    const parts = normalised.split('/');
    if (parts.length !== 2 || parts.some((part) => !part || part === '.' || part === '..')) {
      throw new BadRequestError('That storage key is not valid.');
    }

    const dest = path.resolve(this.root, parts[0] as string, parts[1] as string);
    const root = path.resolve(this.root);
    if (!dest.startsWith(`${root}${path.sep}`)) {
      throw new BadRequestError('That storage key is not valid.');
    }
    return dest;
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
