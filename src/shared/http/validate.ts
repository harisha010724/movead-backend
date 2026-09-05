import { type Request } from 'express';
import { type z } from 'zod';

import { ValidationError } from '../errors';

/**
 * Runtime validation at the Express boundary (architecture Part 3.4).
 *
 * These are explicit calls inside a controller rather than middleware that
 * hangs parsed data off the request object. It costs one line per handler and
 * buys full inference: the controller gets a typed value back, with no cast
 * and no module augmentation to keep in step.
 *
 *   const body = parseBody(req, GpsBatchSchema);   // typed as GpsBatch
 */

export interface FieldIssue {
  /** Dotted path into the payload, e.g. `points.3.lat`. */
  path: string;
  code: string;
  message: string;
}

export function formatIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
}

function parse<T extends z.ZodType>(schema: T, value: unknown, source: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  throw new ValidationError(
    { source, issues: formatIssues(result.error) },
    'Some of the details you sent are not valid.',
  );
}

export function parseBody<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  return parse(schema, req.body, 'body');
}

/**
 * Express 5 exposes `req.query` as a getter, so a parsed value cannot be
 * written back over it. Take the return value instead of expecting coercion
 * to land on the request.
 */
export function parseQuery<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  return parse(schema, req.query, 'query');
}

export function parseParams<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  return parse(schema, req.params, 'params');
}
