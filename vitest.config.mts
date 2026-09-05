import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,mts}', 'src/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    /**
     * Takes a Postgres advisory lock for the whole run, so a second `vitest`
     * process waits rather than truncating this one's tables out from under it.
     * `fileParallelism` below only covers files within a single run.
     */
    globalSetup: ['test/globalSetup.ts'],
    // Modules that touch Postgres or Redis hold connections; running files in
    // separate forks keeps one suite's pool from leaking into another's.
    pool: 'forks',
    /**
     * One database, so one file at a time. Every integration suite truncates
     * to get a clean slate, and two of them doing that concurrently deletes
     * rows the other is mid-way through asserting on.
     */
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/entrypoints/**', 'src/db/migrations/**'],
    },
  },
});
