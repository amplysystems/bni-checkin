import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // 5000ms default was tight enough that PGlite's cold start (each test file
  // spins up its own in-memory Postgres) occasionally timed out under full
  // parallelism — a resource-contention flake, not a real hang. 15000ms gives
  // it headroom without meaningfully slowing down a real failure's feedback.
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 15000 },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
});
