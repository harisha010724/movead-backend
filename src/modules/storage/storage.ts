/**
 * Object storage for campaign creatives.
 *
 * The rest of the app only ever sees a storage key (`{userId}/{uuid}.png`).
 * Today that file lives on disk under `campaign-images/`. When Azure Blob is
 * wired, this module grows a second driver and STORAGE_DRIVER switches — the
 * campaigns table does not change.
 */

export interface StoredObject {
  bytes: Buffer;
  contentType: string;
}

export interface ObjectStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
}
