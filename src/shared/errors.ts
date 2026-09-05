/**
 * The error vocabulary shared by every module.
 *
 * The wire shape is fixed by an already-shipped client: `movead-mobile` reads
 * `code` and `message` off the top level of the body (see its `ApiError`), so
 * the envelope is flat rather than nested under `error`. Codes are snake_case
 * for the same reason — `unauthenticated` and `network_unavailable` are
 * already branched on in the app.
 */

export interface ErrorBody {
  code: string;
  message: string;
  /** Correlation id, so a screenshot of an error is enough to find the logs. */
  requestId?: string;
  /** Field-level detail for validation failures. Never a stack trace. */
  details?: unknown;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /**
   * True for errors we raised deliberately. An unexpected throw is not
   * operational, and is the only kind that pages someone.
   */
  readonly isOperational: boolean = true;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }

  toBody(requestId?: string): ErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(requestId ? { requestId } : {}),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

/** 400 — the request itself is malformed. */
export class BadRequestError extends AppError {
  constructor(message = 'The request was invalid.', details?: unknown) {
    super(400, 'bad_request', message, details);
  }
}

/** 400 — a schema rejected the body, query or params. */
export class ValidationError extends AppError {
  constructor(details: unknown, message = 'Some of the details you entered are not valid.') {
    super(400, 'validation_failed', message, details);
  }
}

/** 401 — no credentials, or they have expired. */
export class UnauthenticatedError extends AppError {
  constructor(message = 'Your session has ended. Sign in again.') {
    super(401, 'unauthenticated', message);
  }
}

/** 403 — authenticated, but not permitted. Keep the reason vague on the wire. */
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this.') {
    super(403, 'forbidden', message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', message = `${resource} was not found.`) {
    super(404, 'not_found', message);
  }
}

/**
 * 409 — the request conflicts with current state. Most often a unique
 * violation that means "this already happened", which is usually correct
 * behaviour rather than a fault: see architecture Part 8.
 */
export class ConflictError extends AppError {
  constructor(message = 'This conflicts with the current state.', details?: unknown) {
    super(409, 'conflict', message, details);
  }
}

/** 422 — well-formed and permitted, but a business rule refuses it. */
export class UnprocessableError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(422, code, message, details);
  }
}

/**
 * 423 — the account itself is locked, as opposed to the credentials being
 * wrong. Distinct from 429 because waiting for a rate limit and waiting for a
 * lockout are different things to tell someone.
 */
export class LockedError extends AppError {
  constructor(message: string, details?: unknown) {
    super(423, 'account_locked', message, details);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Too many attempts. Try again shortly.') {
    super(429, 'rate_limited', message);
  }
}

/** 503 — a dependency is down. Distinct from 500 so clients can retry. */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'The service is temporarily unavailable. Try again shortly.') {
    super(503, 'service_unavailable', message);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
