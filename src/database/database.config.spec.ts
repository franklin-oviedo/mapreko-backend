import { databaseOptions } from './database.config.js';

describe('databaseOptions', () => {
  it('requires an explicit PostgreSQL connection', () => {
    expect(() => databaseOptions({})).toThrow('DATABASE_URL is required');
    expect(() =>
      databaseOptions({ DATABASE_URL: 'mysql://localhost/mapreko' }),
    ).toThrow('must use PostgreSQL');
    expect(() =>
      databaseOptions({ DATABASE_URL: 'postgresql://localhost' }),
    ).toThrow('database name');
  });

  it('keeps migrations explicit and validates the TLS policy', () => {
    const env = { DATABASE_URL: 'postgresql://localhost/mapreko' };
    expect(databaseOptions(env)).toMatchObject({
      synchronize: false,
      migrationsRun: false,
      ssl: false,
    });
    expect(databaseOptions({ ...env, DATABASE_SSL: 'true' }).ssl).toEqual({
      rejectUnauthorized: true,
    });
    expect(() => databaseOptions({ ...env, DATABASE_SSL: 'invalid' })).toThrow(
      'DATABASE_SSL',
    );
    expect(() =>
      databaseOptions({
        DATABASE_URL: `${env.DATABASE_URL}?sslmode=no-verify`,
      }),
    ).toThrow('SSL URL parameters');
  });
});
