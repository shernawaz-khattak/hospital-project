import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StorageError, validateObjectKey, toStorageError } from './objectStorage.js';

function resolveObjectPath(root, key) {
  validateObjectKey(key);
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, ...key.split('/'));
  const relative = path.relative(absoluteRoot, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new StorageError('Invalid storage object key.', { code: 'INVALID_OBJECT_KEY' });
  }
  return { absoluteRoot, target };
}

async function ensureSafeParents(root, target) {
  await fs.mkdir(root, { recursive: true });
  const relativeParent = path.relative(root, path.dirname(target));
  let current = root;
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new StorageError('Storage path contains an unsafe directory.', { code: 'UNSAFE_STORAGE_PATH' });
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(current);
    }
  }
}

export function createLocalStorage({ root }) {
  if (!root) throw new StorageError('A local storage root is required.', { code: 'INVALID_STORAGE_CONFIG' });

  async function head(key) {
    const { absoluteRoot, target } = resolveObjectPath(root, key);
    try {
      await ensureSafeParents(absoluteRoot, target);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new StorageError('Storage object is not a regular file.', { code: 'INVALID_STORAGE_OBJECT' });
      }
      return { exists: true, size: stat.size, metadata: { size: stat.size } };
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (error.code === 'ENOENT') return { exists: false, size: 0, metadata: { size: 0 } };
      throw toStorageError(error, 'head');
    }
  }

  return {
    async put(key, body) {
      const { absoluteRoot, target } = resolveObjectPath(root, key);
      try {
        await ensureSafeParents(absoluteRoot, target);
        if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
          await fs.writeFile(target, body, { mode: 0o600 });
        } else if (body && typeof body.pipe === 'function') {
          await pipeline(body, createWriteStream(target, { mode: 0o600 }));
        } else {
          throw new StorageError('Object body must be a Buffer or readable stream.', { code: 'INVALID_OBJECT_BODY' });
        }
        return { key };
      } catch (error) {
        throw toStorageError(error, 'put');
      }
    },

    async get(key) {
      const { absoluteRoot, target } = resolveObjectPath(root, key);
      try {
        await ensureSafeParents(absoluteRoot, target);
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new StorageError('Storage object is not a regular file.', { code: 'INVALID_STORAGE_OBJECT' });
        }
        return { stream: createReadStream(target), metadata: { size: stat.size } };
      } catch (error) {
        throw toStorageError(error, 'get');
      }
    },

    async getStream(key) {
      return (await this.get(key)).stream;
    },

    async head(key) {
      return head(key);
    },

    async exists(key) {
      return (await head(key)).exists;
    },

    async delete(key) {
      const { absoluteRoot, target } = resolveObjectPath(root, key);
      try {
        await ensureSafeParents(absoluteRoot, target);
        const stat = await fs.lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (!stat) return;
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new StorageError('Storage object is not a regular file.', { code: 'INVALID_STORAGE_OBJECT' });
        }
        await fs.unlink(target);
      } catch (error) {
        throw toStorageError(error, 'delete');
      }
    },
  };
}
