import path from 'node:path';

import { config } from '../../shared/config';

import { LocalObjectStore } from './local.store';
import { type ObjectStore } from './storage';

export type { ObjectStore, StoredObject } from './storage';

let store: ObjectStore | undefined;

/**
 * The process-wide store. Local today; Azure later is another branch here.
 */
export function objectStore(): ObjectStore {
  if (store) return store;

  if (config.storage.driver === 'local') {
    store = new LocalObjectStore(path.resolve(config.storage.campaignImagesDir));
    return store;
  }

  throw new Error(`Unsupported STORAGE_DRIVER: ${String(config.storage.driver)}`);
}

/** Tests replace the singleton so they do not write into `campaign-images/`. */
export function setObjectStoreForTests(next: ObjectStore | undefined): void {
  store = next;
}
