import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/storage.test.js', 'tests/nurse-roster.test.js', 'tests/authorization-unit.test.js', 'tests/admission-billing.test.js', 'tests/clinical-journey.test.js', 'tests/notifications-audit-consistency.test.js', 'tests/database-safety.test.js'],
    env: {
      NODE_ENV: 'test',
      ENABLE_SCHEDULER: 'false',
      UPLOAD_DIR: './storage/test-uploads',
      BACKUP_DIR: './storage/test-backups',
      TEST_DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/hms_storage_isolated',
    },
    testTimeout: 30_000,
    fileParallelism: false,
    setupFiles: [],
  },
});
