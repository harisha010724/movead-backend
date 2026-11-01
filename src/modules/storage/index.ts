import path from 'node:path';

import { config } from '../../shared/config';

import { AzureBlobStore } from './azure.store';
import { LocalObjectStore } from './local.store';
import { type ObjectStore } from './storage';

export type { ObjectStore, StoredObject } from './storage';

let store: ObjectStore | undefined;

/**
 * The process-wide store. `local` writes under CAMPAIGN_IMAGES_DIR;
 * `azure` writes to the Blob container on moveadimgstorage.
 */
export function objectStore(): ObjectStore {
  if (store) return store;

  if (config.storage.driver === 'local') {
    store = new LocalObjectStore(path.resolve(config.storage.campaignImagesDir));
    return store;
  }

  if (config.storage.driver === 'azure') {
    const { account, accountKey, container } = config.storage.azure;
    store = AzureBlobStore.fromAccount(account, accountKey, container);
    return store;
  }

  throw new Error(`Unsupported STORAGE_DRIVER: ${String(config.storage.driver)}`);
}

/** Tests replace the singleton so they do not write into `campaign-images/`. */
export function setObjectStoreForTests(next: ObjectStore | undefined): void {
  store = next;
}
