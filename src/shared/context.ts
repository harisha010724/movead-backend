import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request and per-job ambient state.
 *
 * Architecture Part 14.1 wants a correlation id on every log line so one GPS
 * batch can be followed from ingest through classification to the rupee it
 * produced. Threading that id through every function signature would touch
 * code that has no other reason to know about it, so it lives here instead.
 */

export interface RequestContext {
  /** Correlation id: the inbound `x-request-id`, or one minted per request. */
  requestId: string;
  /** Populated by the auth middleware once it exists. */
  actor?: {
    id: string;
    kind: 'driver' | 'user';
    audience: 'movead-driver' | 'movead-advertiser' | 'movead-admin';
  };
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Attaches the authenticated actor to the live context. Mutating the store is
 * intentional — `runWithContext` has already been entered by the time auth
 * runs, and re-entering it would detach the rest of the middleware chain.
 */
export function setActor(actor: NonNullable<RequestContext['actor']>): void {
  const store = storage.getStore();
  if (store) store.actor = actor;
}
