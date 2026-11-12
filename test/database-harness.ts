import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { databaseOptions } from '../src/database/database.config.js';

export async function createTestDatabase() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      'TEST_DATABASE_URL is required; use a local test database with CREATE SCHEMA permission.',
    );
  }
  const schema = `mapreko_test_${randomUUID().replaceAll('-', '')}`;
  const options = databaseOptions({
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    DATABASE_SSL: process.env.TEST_DATABASE_SSL ?? 'false',
  });
  const admin = await new DataSource({
    ...options,
    logging: false,
  }).initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const database = new DataSource({
    ...options,
    logging: false,
    schema,
    extra: { options: `-c search_path=${schema}`, application_name: schema },
  });
  async function close(): Promise<void> {
    if (database.isInitialized) await database.destroy();
    if (admin.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  }
  try {
    await database.initialize();
    await database.runMigrations();
  } catch (error) {
    await close();
    throw error;
  }
  return { database, schema, close };
}
