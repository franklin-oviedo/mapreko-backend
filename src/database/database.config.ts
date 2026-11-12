import type { DataSourceOptions } from 'typeorm';
import { InitialSchema1794432000000 } from './migrations/1794432000000-initial-schema.js';
import { OptionalGoogleName1794432600000 } from './migrations/1794432600000-optional-google-name.js';

export function databaseOptions(
  env: NodeJS.ProcessEnv = process.env,
): DataSourceOptions {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required. See .env.example.');
  }

  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use PostgreSQL.');
  }
  if (!parsed.hostname || parsed.pathname.length < 2) {
    throw new Error('DATABASE_URL must include a host and database name.');
  }
  if (
    env.DATABASE_SSL !== undefined &&
    !['true', 'false'].includes(env.DATABASE_SSL)
  ) {
    throw new Error('DATABASE_SSL must be true or false.');
  }
  // Keep TLS policy in one place; URL parameters must not override verification.
  if ([...parsed.searchParams.keys()].some((key) => key.startsWith('ssl'))) {
    throw new Error('Use DATABASE_SSL instead of SSL URL parameters.');
  }

  return {
    type: 'postgres',
    url,
    ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
    synchronize: false,
    migrationsRun: false,
    migrations: [InitialSchema1794432000000, OptionalGoogleName1794432600000],
    migrationsTransactionMode: 'all',
    logging: ['error', 'warn'],
  };
}
