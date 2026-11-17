import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { stat } from 'node:fs/promises';
import { env } from '../../config/env.js';
import { createLocalStorage } from './local.js';
import { StorageError, validateObjectKey, toStorageError } from './objectStorage.js';

let r2Client;

function getR2Client() {
  if (!r2Client) {
    r2Client = new S3Client({
      region: env.R2_REGION,
      endpoint: env.R2_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return r2Client;
}

function metadataFrom(output = {}) {
  return {
    size: output.ContentLength ?? 0,
    contentType: output.ContentType,
    sha256: output.Metadata?.sha256,
    userMetadata: output.Metadata || {},
  };
}

function createR2Storage(bucket) {
  if (!bucket) throw new StorageError('An R2 bucket is required.', { code: 'INVALID_STORAGE_CONFIG' });

  return {
    async put(key, body, options = {}) {
      validateObjectKey(key);
      try {
        const input = { Bucket: bucket, Key: key, Body: body };
        if (options.contentType) input.ContentType = options.contentType;
        const metadata = { ...(options.userMetadata || {}) };
        if (options.sha256) metadata.sha256 = options.sha256;
        if (Object.keys(metadata).length) {
          input.Metadata = Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k.toLowerCase(), String(v)]));
        }
        if (Buffer.isBuffer(body) || body instanceof Uint8Array) input.ContentLength = body.byteLength;
        else if (body?.path && typeof body.path === 'string') input.ContentLength = (await stat(body.path)).size;
        await getR2Client().send(new PutObjectCommand(input));
        return { key };
      } catch (error) {
        throw toStorageError(error, 'put');
      }
    },

    async get(key) {
      validateObjectKey(key);
      try {
        const output = await getR2Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return { stream: output.Body, metadata: metadataFrom(output) };
      } catch (error) {
        throw toStorageError(error, 'get');
      }
    },

    async getStream(key) {
      return (await this.get(key)).stream;
    },

    async head(key) {
      validateObjectKey(key);
      try {
        const output = await getR2Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { exists: true, size: output.ContentLength ?? 0, metadata: metadataFrom(output) };
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') {
          return { exists: false, size: 0, metadata: { size: 0 } };
        }
        throw toStorageError(error, 'head');
      }
    },

    async exists(key) {
      return (await this.head(key)).exists;
    },

    async delete(key) {
      validateObjectKey(key);
      try {
        await getR2Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        throw toStorageError(error, 'delete');
      }
    },
  };
}

export function createStorageForProvider(provider, rootOrBucket, bucketOverride) {
  if (provider === 'local') return createLocalStorage({ root: rootOrBucket });
  if (provider === 'r2') return createR2Storage(bucketOverride || rootOrBucket);
  throw new StorageError('Unsupported storage provider.', { code: 'INVALID_STORAGE_PROVIDER' });
}

export function uploadStorage() {
  if (env.STORAGE_PROVIDER === 'r2') return createR2Storage(env.R2_BUCKET_UPLOADS);
  return createLocalStorage({ root: env.UPLOAD_DIR });
}

export function backupStorage() {
  if (env.STORAGE_PROVIDER === 'r2') return createR2Storage(env.R2_BUCKET_BACKUPS);
  return createLocalStorage({ root: env.BACKUP_DIR });
}
