import { describe, expect, it } from 'vitest';

import { BadRequestError } from '../src/shared/errors';
import { assertObjectKey } from '../src/modules/storage/object-key';

describe('assertObjectKey', () => {
  it('accepts owner/file', () => {
    expect(assertObjectKey('prf_1/shot.jpg')).toEqual({ owner: 'prf_1', file: 'shot.jpg' });
  });

  it('refuses path traversal and extra segments', () => {
    expect(() => assertObjectKey('../etc/passwd')).toThrow(BadRequestError);
    expect(() => assertObjectKey('a/b/c')).toThrow(BadRequestError);
    expect(() => assertObjectKey('alone')).toThrow(BadRequestError);
  });
});
