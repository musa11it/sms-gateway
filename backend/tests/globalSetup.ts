import { execSync } from 'child_process';
import path from 'path';
import dotenv from 'dotenv';

/** Apply migrations to the test database once before the suite. */
export default function setup() {
  const fileEnv = dotenv.config({ path: path.resolve(__dirname, '../.env') }).parsed ?? {};
  const url = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;
  if (!url || url === fileEnv.DATABASE_URL) throw new Error('Refusing to run tests: TEST_DATABASE_URL must point to a separate database');
  execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' });
}
