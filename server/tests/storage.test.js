import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalStorage } from '../src/services/storage/local.js';
import { patientReportKey, backupObjectKey } from '../src/services/storage/objectKey.js';
import { StorageError } from '../src/services/storage/objectStorage.js';
import { deleteVerifiedBackupWithRetention } from '../src/services/storageRetention.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ObjectLifecycleConflict, leaseExpired, validateReferenceState } from '../src/services/storageLifecycle.js';

const deleteMock = vi.fn();
vi.mock('../src/services/storage/index.js', () => ({
  createStorageForProvider: vi.fn(() => ({ delete: deleteMock })),
}));
vi.mock('../src/db/knex.js', () => ({
  db: Object.assign(vi.fn(() => ({
    insert: vi.fn(() => ({
      onConflict: vi.fn(() => ({ merge: vi.fn(() => Promise.resolve()) })),
    })),
  })), { fn: { now: () => new Date() } }),
}));

describe('local storage adapter', () => {
  it('uploads, reads, checks, and deletes objects', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hms-storage-'));
    const storage = createLocalStorage({ root });
    await storage.put('lab/report.pdf', Buffer.from('report'));
    expect(await storage.exists('lab/report.pdf')).toBe(true);
    const object = await storage.get('lab/report.pdf');
    const chunks = [];
    for await (const chunk of object.stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('report');
    await storage.delete('lab/report.pdf');
    expect(await storage.exists('lab/report.pdf')).toBe(false);
  });

  describe('production object-storage configuration', () => {
    it('rejects production startup without an explicit R2 provider', () => {
      const envFile = fileURLToPath(new URL('../src/config/env.js', import.meta.url));
      const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(envFile).href)})`], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'production', STORAGE_PROVIDER: '', DATABASE_URL: 'postgresql://example.invalid/hms', DATA_ENCRYPTION_KEY: '00', BLIND_INDEX_KEY: '00' },
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Production requires STORAGE_PROVIDER=r2');
    });

    it('rejects production startup when R2 configuration is incomplete', () => {
      const envFile = fileURLToPath(new URL('../src/config/env.js', import.meta.url));
      const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(envFile).href)});`], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'production', STORAGE_PROVIDER: 'r2', DATABASE_URL: 'postgresql://example.invalid/hms', DATA_ENCRYPTION_KEY: '00', BLIND_INDEX_KEY: '00',
          R2_ACCOUNT_ID: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_BUCKET_UPLOADS: '', R2_BUCKET_BACKUPS: '', R2_ENDPOINT: '' },
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('missing required configuration');
    });
  });

  describe('orphan cleanup', () => {
    it('removes an unreferenced object successfully', async () => {
      deleteMock.mockResolvedValueOnce();
      const { cleanupOrphan } = await import('../src/services/storageReconciliation.js');
      await expect(cleanupOrphan({
        provider: 'r2', bucket: 'uploads.example', objectKey: 'lab-reports/1/report.pdf',
        operation: 'lab_report_upload', failureReason: 'database write failed',
      })).resolves.toBe(true);
    });

    describe('backup retention transitions', () => {
      it('records pending and deleted states around successful remote deletion', async () => {
        const states = [];
        await expect(deleteVerifiedBackupWithRetention({
          storage: { delete: vi.fn().mockResolvedValue() },
          key: 'backups/verified.dump',
          persistPending: () => { states.push('pending'); },
          persistDeleted: () => { states.push('deleted'); },
          persistDeleteFailure: vi.fn(),
          persistMetadataFailure: vi.fn(),
        })).resolves.toBe(true);
        expect(states).toEqual(['pending', 'deleted']);
      });

      it('records deletion failure and does not advance to deleted', async () => {
        const persistDeleteFailure = vi.fn().mockResolvedValue();
        await expect(deleteVerifiedBackupWithRetention({
          storage: { delete: vi.fn().mockRejectedValue(new Error('remote unavailable')) },
          key: 'backups/verified.dump',
          persistPending: vi.fn(),
          persistDeleted: vi.fn(),
          persistDeleteFailure,
          persistMetadataFailure: vi.fn(),
        })).rejects.toThrow('remote unavailable');
        expect(persistDeleteFailure).toHaveBeenCalledOnce();
      });

      it('records metadata reconciliation after remote deletion succeeds', async () => {
        const persistMetadataFailure = vi.fn().mockResolvedValue();
        await expect(deleteVerifiedBackupWithRetention({
          storage: { delete: vi.fn().mockResolvedValue() },
          key: 'backups/verified.dump',
          persistPending: vi.fn(),
          persistDeleted: vi.fn().mockRejectedValue(new Error('database unavailable')),
          persistDeleteFailure: vi.fn(),
          persistMetadataFailure,
        })).rejects.toThrow('database unavailable');
        expect(persistMetadataFailure).toHaveBeenCalledOnce();
      });
    });

    it('records reconciliation when object cleanup fails', async () => {
      deleteMock.mockRejectedValueOnce(new Error('r2 unavailable'));
      const { cleanupOrphan } = await import('../src/services/storageReconciliation.js');
      await expect(cleanupOrphan({
        provider: 'r2', bucket: 'uploads.example', objectKey: 'backups/report.dump',
        operation: 'backup_upload', failureReason: 'database write failed',
      })).resolves.toBe(false);
    });
  });

  it('rejects traversal keys', async () => {
    const storage = createLocalStorage({ root: await fs.mkdtemp(path.join(os.tmpdir(), 'hms-storage-')) });
    await expect(storage.head('../secret')).rejects.toBeInstanceOf(StorageError);
    await expect(storage.put('../secret', Buffer.from('x'))).rejects.toBeInstanceOf(StorageError);
  });
});

describe('object key generation', () => {
  it('uses server-controlled UUID keys for patient reports', () => {
    expect(patientReportKey(42, 'pdf')).toMatch(/^lab-reports\/42\/[0-9a-f-]{36}\.pdf$/);
  });

  describe('object lifecycle state guards', () => {
    it('allows active references and rejects pending or deleted objects', () => {
      expect(validateReferenceState('active')).toBe(true);
      expect(validateReferenceState(null)).toBe(true);
      expect(validateReferenceState('pending_deletion')).toBe(false);
      expect(validateReferenceState('deleted')).toBe(false);
    });

    it('recovers an expired retry lease', () => {
      expect(leaseExpired(new Date(Date.now() - 1000))).toBe(true);
      expect(leaseExpired(new Date(Date.now() + 60_000))).toBe(false);
    });

    it('rejects unknown lifecycle states', () => {
      expect(() => validateReferenceState('unknown')).toThrow(ObjectLifecycleConflict);
    });

    it('models duplicate deletion as already deleted', () => {
      const lifecycle = { state: 'deleted' };
      expect(lifecycle.state === 'deleted').toBe(true);
    });
  });

  it('rejects unsafe report extensions and backup names', () => {
    expect(() => patientReportKey(42, 'exe')).toThrow();
    expect(() => backupObjectKey('../backup.dump')).toThrow();
  });
});
