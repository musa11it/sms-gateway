import path from 'path';
import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

const fileEnv = dotenv.config({ path: path.resolve(__dirname, '.env') }).parsed ?? {};
const testDb = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;
if (!testDb) throw new Error('TEST_DATABASE_URL must be set (see .env.example)');

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/globalSetup.ts'],
    // Integration tests share one database; run files sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDb,
      SIMULATION_SMS_MIN_DELAY_MS: '0',
      SIMULATION_SMS_MAX_DELAY_MS: '0',
      SIMULATION_SMS_FAILURE_RATE: '0',
      RUN_WORKERS: 'false',
    },
  },
});
