import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { DataSource, QueryRunner } from 'typeorm';
import { createTestDatabase } from './database-harness.js';

describe('PostgreSQL schema', () => {
  let harness: Awaited<ReturnType<typeof createTestDatabase>>;
  let database: DataSource;
  let runner: QueryRunner;
  let schema: string;
  let userId: string;
  let otherUserId: string;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let propertyId: string;
  let assetId: string;
  let orderId: string;

  beforeAll(async () => {
    harness = await createTestDatabase();
    database = harness.database;
    schema = harness.schema;
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  async function insertId(
    sql: string,
    values: unknown[] = [],
  ): Promise<string> {
    const rows = await runner.query<{ id: string }[]>(sql, values);
    return rows[0].id;
  }

  async function rejectsConstraint(
    sql: string,
    values: unknown[],
    code: string,
  ): Promise<void> {
    await runner.query('SAVEPOINT expected_failure');
    try {
      await expect(runner.query(sql, values)).rejects.toMatchObject({ code });
    } finally {
      await runner.query('ROLLBACK TO SAVEPOINT expected_failure');
      await runner.query('RELEASE SAVEPOINT expected_failure');
    }
  }

  beforeEach(async () => {
    runner = database.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    userId = await insertId(
      `INSERT INTO users (email, given_name) VALUES ('owner@example.test', 'Owner') RETURNING id`,
    );
    otherUserId = await insertId(
      `INSERT INTO users (email, given_name) VALUES ('other@example.test', 'Other') RETURNING id`,
    );
    workspaceId = await insertId(
      `INSERT INTO workspaces (kind, name, owner_user_id) VALUES ('personal', 'Home', $1) RETURNING id`,
      [userId],
    );
    otherWorkspaceId = await insertId(
      `INSERT INTO workspaces (kind, name, owner_user_id) VALUES ('business', 'Company', $1) RETURNING id`,
      [otherUserId],
    );
    await runner.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($3, $4, 'admin')`,
      [workspaceId, userId, otherWorkspaceId, otherUserId],
    );
    propertyId = await insertId(
      `INSERT INTO properties (workspace_id, name, kind, address_line1)
       VALUES ($1, 'Home', 'house', 'Example street') RETURNING id`,
      [workspaceId],
    );
    assetId = await insertId(
      `INSERT INTO assets (workspace_id, property_id, kind, name)
       VALUES ($1, $2, 'installation', 'Water system') RETURNING id`,
      [workspaceId, propertyId],
    );
    orderId = await insertId(
      `INSERT INTO work_orders (workspace_id, property_id, asset_id, title, due_at, created_by)
       VALUES ($1, $2, $3, 'Inspect water system', now() + interval '1 day', $4) RETURNING id`,
      [workspaceId, propertyId, assetId, userId],
    );
  });

  afterEach(async () => {
    if (runner?.isTransactionActive) await runner.rollbackTransaction();
    if (runner && !runner.isReleased) await runner.release();
  });

  it('supports personal and multiple business memberships without granting platform administration', async () => {
    await runner.query(
      `INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2)`,
      [otherWorkspaceId, userId],
    );
    const thirdWorkspaceId = await insertId(
      `INSERT INTO workspaces (kind, name, owner_user_id) VALUES ('business', 'Second company', $1) RETURNING id`,
      [userId],
    );
    await runner.query(
      `INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2)`,
      [thirdWorkspaceId, userId],
    );
    await runner.query('SET CONSTRAINTS ALL IMMEDIATE');
    const members = await runner.query<{ count: string }[]>(
      'SELECT count(*) FROM workspace_members WHERE user_id = $1',
      [userId],
    );
    expect(members[0].count).toBe('3');
    expect(await runner.query('SELECT * FROM platform_admins')).toEqual([]);
    await rejectsConstraint(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'platform_admin')`,
      [thirdWorkspaceId, otherUserId],
      '23514',
    );
  });

  it('keeps personal spaces private and unique, with an owner membership', async () => {
    await rejectsConstraint(
      `INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2)`,
      [workspaceId, otherUserId],
      '23514',
    );
    await rejectsConstraint(
      `INSERT INTO workspaces (kind, name, owner_user_id) VALUES ('personal', 'Duplicate', $1)`,
      [userId],
      '23505',
    );
    await rejectsConstraint(
      `UPDATE workspaces SET kind = 'business' WHERE id = $1`,
      [workspaceId],
      '23514',
    );
    await runner.query(
      `INSERT INTO workspaces (kind, name, owner_user_id) VALUES ('business', 'Missing owner membership', $1)`,
      [userId],
    );
    await rejectsConstraint('SET CONSTRAINTS ALL IMMEDIATE', [], '23503');
  });

  it('normalizes email uniqueness and rejects concurrent duplicate Google registration atomically', async () => {
    await rejectsConstraint(
      `INSERT INTO users (email, given_name) VALUES (' OWNER@example.test ', 'Duplicate')`,
      [],
      '23505',
    );
    const subject = randomUUID();
    const register = () =>
      database.transaction(async (manager) => {
        const users = await manager.query<{ id: string }[]>(
          `INSERT INTO users (email, given_name) VALUES ($1, 'New') RETURNING id`,
          [`${randomUUID()}@example.test`],
        );
        await manager.query(
          `INSERT INTO auth_identities (user_id, subject, email)
           VALUES ($1, $2, 'google@example.test')`,
          [users[0].id, subject],
        );
      });
    const results = await Promise.allSettled([register(), register()]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: '23505' } });
    const rows = await database.query<{ count: string }[]>(
      `SELECT count(*) FROM users WHERE given_name = 'New'`,
    );
    expect(rows[0].count).toBe('1');
  });

  it('stores revocable sessions and a single-use token rotation chain, never raw credentials', async () => {
    const sessionId = await insertId(
      `INSERT INTO sessions (user_id, application, expires_at)
       VALUES ($1, 'user', now() + interval '7 days') RETURNING id`,
      [userId],
    );
    const tokenId = await insertId(
      `INSERT INTO session_refresh_tokens (session_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '7 days') RETURNING id`,
      [sessionId, 'a'.repeat(64)],
    );
    await runner.query(
      'UPDATE session_refresh_tokens SET used_at = now() WHERE id = $1',
      [tokenId],
    );
    await runner.query(
      `INSERT INTO session_refresh_tokens (session_id, token_hash, rotated_from_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '7 days')`,
      [sessionId, 'b'.repeat(64), tokenId],
    );
    await rejectsConstraint(
      `INSERT INTO session_refresh_tokens (session_id, token_hash, rotated_from_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '7 days')`,
      [sessionId, 'c'.repeat(64), tokenId],
      '23505',
    );
    await rejectsConstraint(
      `INSERT INTO session_refresh_tokens (session_id, token_hash, expires_at)
       VALUES ($1, 'raw-refresh-token', now() + interval '7 days')`,
      [sessionId],
      '23514',
    );
    await runner.query(
      `UPDATE sessions SET revoked_at = now(), ended_at = now(), revocation_reason = 'sign_out' WHERE id = $1`,
      [sessionId],
    );
    expect(
      await runner.query(
        'SELECT id FROM sessions WHERE id = $1 AND revoked_at IS NULL AND ended_at IS NULL AND expires_at > now()',
        [sessionId],
      ),
    ).toEqual([]);
  });

  it('rejects properties, assets, plans and orders linked across workspaces or properties', async () => {
    await rejectsConstraint(
      `INSERT INTO assets (workspace_id, property_id, kind, name) VALUES ($1, $2, 'equipment', 'Invalid')`,
      [otherWorkspaceId, propertyId],
      '23503',
    );
    const secondProperty = await insertId(
      `INSERT INTO properties (workspace_id, name, kind, address_line1)
       VALUES ($1, 'Second home', 'apartment', 'Other street') RETURNING id`,
      [workspaceId],
    );
    await rejectsConstraint(
      `INSERT INTO work_orders (workspace_id, property_id, asset_id, title, due_at, created_by)
       VALUES ($1, $2, $3, 'Invalid asset location', now(), $4)`,
      [workspaceId, secondProperty, assetId, userId],
      '23503',
    );
    await rejectsConstraint(
      `INSERT INTO maintenance_plans
       (workspace_id, property_id, title, recurrence_unit, recurrence_interval, starts_on, next_due_at, created_by)
       VALUES ($1, $2, 'Invalid plan', 'month', 1, current_date, now(), $3)`,
      [otherWorkspaceId, propertyId, otherUserId],
      '23503',
    );
    await rejectsConstraint(
      `INSERT INTO reminders (workspace_id, recipient_user_id, work_order_id, remind_at, channel)
       VALUES ($1, $2, $3, now(), 'email')`,
      [otherWorkspaceId, otherUserId, orderId],
      '23503',
    );
  });

  it('only assigns work and records history for members of the same workspace', async () => {
    await rejectsConstraint(
      `INSERT INTO work_order_assignees (workspace_id, work_order_id, user_id, assigned_by)
       VALUES ($1, $2, $3, $4)`,
      [workspaceId, orderId, otherUserId, userId],
      '23503',
    );
    await runner.query(
      `INSERT INTO work_order_assignees (workspace_id, work_order_id, user_id, assigned_by)
       VALUES ($1, $2, $3, $3)`,
      [workspaceId, orderId, userId],
    );
    await runner.query(
      `INSERT INTO maintenance_records
       (workspace_id, property_id, asset_id, work_order_id, performed_by, performed_at, summary, cost, currency_code)
       VALUES ($1, $2, $3, $4, $5, now(), 'Inspected', 100.25, 'DOP')`,
      [workspaceId, propertyId, assetId, orderId, userId],
    );
    await rejectsConstraint(
      'DELETE FROM assets WHERE id = $1',
      [assetId],
      '23503',
    );
    await rejectsConstraint(
      `INSERT INTO maintenance_records
       (workspace_id, property_id, performed_by, performed_at, summary, cost, currency_code)
       VALUES ($1, $2, $3, now(), 'Invalid cost', -1, 'DOP')`,
      [workspaceId, propertyId, userId],
      '23514',
    );
  });

  it('deduplicates scheduled occurrences and validates recurrence and completion', async () => {
    const planId = await insertId(
      `INSERT INTO maintenance_plans
       (workspace_id, property_id, asset_id, title, recurrence_unit, recurrence_interval, starts_on, next_due_at, created_by)
       VALUES ($1, $2, $3, 'Monthly inspection', 'month', 1, current_date, now(), $4) RETURNING id`,
      [workspaceId, propertyId, assetId, userId],
    );
    await rejectsConstraint(
      'UPDATE maintenance_plans SET recurrence_interval = 0 WHERE id = $1',
      [planId],
      '23514',
    );
    const scheduledOrder = `INSERT INTO work_orders
      (workspace_id, property_id, plan_id, scheduled_for, title, due_at, created_by)
      VALUES ($1, $2, $3, '2030-01-01T10:00:00Z', 'Scheduled inspection', now(), $4)`;
    const values = [workspaceId, propertyId, planId, userId];
    await runner.query(scheduledOrder, values);
    await rejectsConstraint(scheduledOrder, values, '23505');
    await rejectsConstraint(
      `UPDATE work_orders SET status = 'completed' WHERE id = $1`,
      [orderId],
      '23514',
    );
    await runner.query(
      `UPDATE work_orders SET status = 'completed', completed_at = now() WHERE id = $1`,
      [orderId],
    );
  });

  it('requires exactly one reminder target and deduplicates deliveries', async () => {
    const reminder = `INSERT INTO reminders
      (workspace_id, recipient_user_id, work_order_id, remind_at, channel)
      VALUES ($1, $2, $3, '2030-01-01T09:00:00Z', 'in_app')`;
    const values = [workspaceId, userId, orderId];
    await runner.query(reminder, values);
    await rejectsConstraint(reminder, values, '23505');
    await rejectsConstraint(
      `INSERT INTO reminders (workspace_id, recipient_user_id, remind_at, channel)
       VALUES ($1, $2, now(), 'email')`,
      [workspaceId, userId],
      '23514',
    );
  });

  it('requires an explicit internal admin grant to author knowledge articles', async () => {
    const categoryId = await insertId(
      `INSERT INTO knowledge_categories (slug, name) VALUES ('water', 'Water') RETURNING id`,
    );
    const article = `INSERT INTO knowledge_articles (category_id, slug, title, summary, content, author_user_id)
      VALUES ($1, 'water-system', 'Water systems', 'Summary', 'Content', $2)`;
    await rejectsConstraint(article, [categoryId, userId], '23503');
    await runner.query(
      `INSERT INTO platform_admins (user_id, role, granted_by) VALUES ($1, 'admin', $1)`,
      [userId],
    );
    await runner.query(article, [categoryId, userId]);
    await rejectsConstraint(
      `UPDATE knowledge_articles SET status = 'published' WHERE slug = 'water-system'`,
      [],
      '23514',
    );
  });

  it('automatically timestamps profile changes without changing Google identity', async () => {
    await runner.query(
      `INSERT INTO auth_identities (user_id, subject, email) VALUES ($1, 'stable-google-sub', 'owner@example.test')`,
      [userId],
    );
    await runner.query(
      `UPDATE users SET display_name = 'Updated', updated_at = '2000-01-01' WHERE id = $1`,
      [userId],
    );
    const rows = await runner.query<{ subject: string; updated: boolean }[]>(
      `SELECT i.subject, u.updated_at > '2000-01-01'::timestamptz AS updated
       FROM users u JOIN auth_identities i ON i.user_id = u.id WHERE u.id = $1`,
      [userId],
    );
    expect(rows[0]).toEqual({ subject: 'stable-google-sub', updated: true });
  });

  it('reverts and reapplies the migration without leftover tables or functions', async () => {
    await runner.rollbackTransaction();
    await runner.release();
    for (
      let remaining = database.migrations.length;
      remaining > 0;
      remaining--
    ) {
      await database.undoLastMigration();
    }
    const tables = await database.query<{ tablename: string }[]>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
      [schema],
    );
    expect(tables.map((table) => table.tablename)).toEqual(['migrations']);
    const functions = await database.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`,
      [schema],
    );
    expect(functions).toEqual([]);
    expect(await database.runMigrations()).toHaveLength(
      database.migrations.length,
    );
    expect(await database.showMigrations()).toBe(false);
  });
});
