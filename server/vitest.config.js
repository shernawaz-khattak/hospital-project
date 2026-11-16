import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test', ENABLE_SCHEDULER: 'false', UPLOAD_DIR: './storage/test-uploads', BACKUP_DIR: './storage/test-backups' },
    fileParallelism: false, // all files share one test database
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
