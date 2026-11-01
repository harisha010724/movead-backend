import { BlobServiceClient, StorageSharedKeyCredential, type ContainerClient } from '@azure/storage-blob';

import { assertObjectKey } from './object-key';
import { type ObjectStore, type StoredObject } from './storage';

/**
 * Azure Blob store. Same `{owner}/{file}` keys as the disk driver.
 * The container is created on first use if it does not exist.
 */
export class AzureBlobStore implements ObjectStore {
  private readonly ready: Promise<void>;

  constructor(private readonly container: ContainerClient) {
    this.ready = this.container.createIfNotExists().then(() => undefined);
  }

  static fromAccount(account: string, accountKey: string, containerName: string): AzureBlobStore {
    const credential = new StorageSharedKeyCredential(account, accountKey);
    const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential);
    return new AzureBlobStore(service.getContainerClient(containerName));
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.ready;
    const { owner, file } = assertObjectKey(key);
    await this.container.getBlockBlobClient(`${owner}/${file}`).uploadData(bytes, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
  }

  async get(key: string): Promise<StoredObject | null> {
    await this.ready;
    const { owner, file } = assertObjectKey(key);
    try {
      const blob = this.container.getBlockBlobClient(`${owner}/${file}`);
      const downloaded = await blob.downloadToBuffer();
      const props = await blob.getProperties();
      return {
        bytes: downloaded,
        contentType: props.contentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    (error as { statusCode?: number }).statusCode === 404
  );
}
