import { BadRequestError } from '../../shared/errors';

/**
 * Every stored object is `{owner}/{file}` with no `..` segments.
 * The owner is a user id, proof id, or campaign id — never a path.
 */
export function assertObjectKey(key: string): { owner: string; file: string } {
  const normalised = key.replace(/\\/g, '/');
  const parts = normalised.split('/');
  if (parts.length !== 2 || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new BadRequestError('That storage key is not valid.');
  }
  return { owner: parts[0] as string, file: parts[1] as string };
}
