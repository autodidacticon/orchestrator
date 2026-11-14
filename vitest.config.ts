import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // One Postgres for the run (or none, said in one line); see test/setup/postgres.ts.
    globalSetup: ['test/setup/postgres.ts'],
  },
});
