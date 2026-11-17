export class StorageError extends Error {
  constructor(message, { code = 'STORAGE_ERROR', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'StorageError';
    this.code = code;
  }
}

export function validateObjectKey(key) {
  if (typeof key !== 'string' || !key || key.length > 1024 || key.startsWith('/') || key.includes('\\') || key.includes('\0')) {
    throw new StorageError('Invalid storage object key.', { code: 'INVALID_OBJECT_KEY' });
  }
  const segments = key.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new StorageError('Invalid storage object key.', { code: 'INVALID_OBJECT_KEY' });
  }
  return key;
}

export function toStorageError(error, operation) {
  if (error instanceof StorageError) return error;
  return new StorageError(`Object storage ${operation} failed.`, {
    code: error?.name || 'STORAGE_ERROR',
    cause: error,
  });
}
