import { type ErrorRequestHandler, type RequestHandler } from 'express';
import {
  ConnectionError,
  DatabaseError,
  ForeignKeyConstraintError,
  UniqueConstraintError,
  ValidationError as SequelizeValidationError,
} from 'sequelize';
import { z } from 'zod';

import { getRequestId } from '../../context';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
  type ErrorBody,
} from '../../errors';
import { logger } from '../../logger';
import { formatIssues } from '../validate';

/** Terminal 404 for anything no router claimed. */
export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    next(new NotFoundError('Endpoint', `No endpoint matches ${req.method} ${req.path}.`));
  };
}

/**
 * The single place an exception becomes an HTTP response.
 *
 * Express 5 forwards a rejected promise from any handler here automatically,
 * so controllers can be plain `async` functions with no wrapper.
 */
export function errorHandler(): ErrorRequestHandler {
  // Express identifies error middleware by arity, so `next` must stay.
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const appError = toAppError(error);
    const requestId = getRequestId();
    const body: ErrorBody = appError.toBody(requestId);

    const log = logger.child({ route: `${req.method} ${req.path}`, code: body.code });

    if (appError.status >= 500) {
      // Unexpected: keep the original error, stack and all.
      log.error({ err: error }, appError.message);
    } else {
      log.info({ status: appError.status }, appError.message);
    }

    res.status(appError.status).json(body);
  };
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  // A schema that was parsed outside `validate.ts` — treat it the same way.
  if (error instanceof z.ZodError) {
    return new ValidationError({ issues: formatIssues(error) });
  }

  if (error instanceof UniqueConstraintError) {
    // Architecture Part 8: a unique violation is usually the database
    // enforcing "this already happened", which is a 409 and not a fault.
    return new ConflictError('This has already been recorded.', {
      fields: Object.keys(error.fields),
    });
  }

  if (error instanceof ForeignKeyConstraintError) {
    return new ConflictError('A related record is missing or still in use.');
  }

  if (error instanceof SequelizeValidationError) {
    return new ValidationError({
      issues: error.errors.map((item) => ({
        path: item.path ?? '',
        code: item.type ?? 'invalid',
        message: item.message,
      })),
    });
  }

  if (error instanceof ConnectionError) {
    return new ServiceUnavailableError('The database is unreachable. Try again shortly.');
  }

  if (error instanceof SyntaxError && 'body' in error) {
    return new ValidationError({ issues: [] }, 'The request body is not valid JSON.');
  }

  if (error instanceof DatabaseError) {
    return new InternalError('A database error occurred.');
  }

  return new InternalError();
}

/**
 * 500 — never carries the underlying message. The detail is in the logs under
 * the request id, which the client does receive.
 */
class InternalError extends AppError {
  override readonly isOperational = false;

  constructor(message = 'Something went wrong. Please try again.') {
    super(500, 'internal_error', message);
  }
}
