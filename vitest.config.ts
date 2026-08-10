import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // 5000ms default was tight enough that PGlite's cold start (each test file
  // spins up its own in-memory Postgres) occasionally timed out under full
  // parallelism — a resource-contention flake, not a real hang. 15000ms gives
  // it headroom without meaningfully slowing down a real failure's feedback.
  // hookTimeout needs the same bump: PGlite startup happens in beforeEach
  // (createTestDb + seed), and vitest's hookTimeout is a SEPARATE 10000ms
  // default from testTimeout — raising only testTimeout left beforeEach
  // exposed to the exact contention this comment already describes (more
  // test files -> more concurrent PGlite instances -> more frequent
  // "Hook timed out in 10000ms" failures with no code-level cause).
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 15000, hookTimeout: 15000 },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
});
