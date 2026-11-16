import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/auth.test.js',
      'tests/clinical-flow.test.js',
      'tests/patients-appointments.test.js',
      'tests/rbac-admin.test.js',
      'tests/system.test.js',
      'tests/security-review.test.js',
    ],
    globalSetup: ['./tests/globalSetup.js'],
    env: { NODE_ENV: 'test', ENABLE_SCHEDULER: 'false', ALLOW_TEST_DATABASE_RESET: 'true', TEST_DATABASE_RESET_CONFIRM: 'HMS_DISPOSABLE_DATABASE_RESET' },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
