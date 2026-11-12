import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { stringifyCookie } from 'cookie';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import type { IssuedSession } from '../src/auth/auth.types.js';
import { configureHttp } from '../src/configure-http.js';
import { createTestDatabase } from './database-harness.js';

describe('Dashboard HTTP + PostgreSQL', () => {
  let app: INestApplication;
  let harness: Awaited<ReturnType<typeof createTestDatabase>>;
  let auth: AuthService;
  const origin = 'http://localhost:4200';
  const api = '/api/dashboard/user';
  const cookie = (issued: IssuedSession) =>
    stringifyCookie({ mapreko_user_access: issued.accessToken });
  const signIn = () =>
    auth.signIn(
      {
        subject: randomUUID(),
        email: `${randomUUID()}@example.test`,
        givenName: 'Ana',
        familyName: null,
        avatarUrl: null,
      },
      'user',
    );
  const post = (issued: IssuedSession, path: string, body: object) =>
    request(app.getHttpServer())
      .post(`${api}/${path}`)
      .set('Cookie', cookie(issued))
      .set('Origin', origin)
      .set('X-Mapreko-Request', '1')
      .send(body);
  const summary = (issued: IssuedSession, query = {}) =>
    request(app.getHttpServer())
      .get(`${api}/summary`)
      .set('Cookie', cookie(issued))
      .query(query);
  const newProperty = async (issued: IssuedSession) => {
    const response = await post(issued, 'properties', {
      workspaceId: issued.session.workspaces[0].id,
      name: 'Mi apartamento',
      kind: 'apartment',
      address: 'Calle de prueba 10',
    }).expect(201);
    return String(response.body.id);
  };

  beforeAll(async () => {
    harness = await createTestDatabase();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(harness.database)
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          FRONTEND_ORIGIN: origin,
          AUTH_SECRET: randomBytes(48).toString('hex'),
        }),
      )
      .compile();
    app = module.createNestApplication();
    configureHttp(app);
    await app.init();
    auth = app.get(AuthService);
  });
  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.close();
  });

  it('requires authentication and reports an honest empty state', async () => {
    await request(app.getHttpServer()).get(`${api}/summary`).expect(401);
    const issued = await signIn();
    const response = await summary(issued).expect(200);
    expect(response.body.properties).toEqual([]);
    expect(response.body.tasks).toEqual([]);
    expect(response.body.metrics).toMatchObject({
      propertyCount: 0,
      monthlyTasks: 0,
      completedMonthly: 0,
      attentionCount: 0,
      compliance: null,
      complianceChange: null,
    });
    await request(app.getHttpServer())
      .post(`${api}/tasks`)
      .set('Cookie', cookie(issued))
      .send({})
      .expect(403);
  });

  it('persists property, task and creation history and returns them after a fresh request', async () => {
    const issued = await signIn();
    const propertyId = await newProperty(issued);
    const created = await post(issued, 'tasks', {
      propertyId,
      title: 'Revisar filtracion',
      priority: 'high',
      dueOn: '2030-01-02',
    }).expect(201);
    const response = await summary(issued).expect(200);
    expect(response.body.metrics).toMatchObject({
      propertyCount: 1,
      housingCount: 1,
      highPriority: 1,
      attentionCount: 1,
    });
    expect(response.body.tasks).toEqual([
      expect.objectContaining({
        id: created.body.id,
        propertyId,
        title: 'Revisar filtracion',
        dueAt: '2030-01-02T23:59:59.999Z',
      }),
    ]);
    const [activity] = await harness.database.query<
      { kind: string; actor: string }[]
    >(
      `
      SELECT kind, actor_user_id AS actor FROM work_order_activities WHERE work_order_id = $1
    `,
      [created.body.id],
    );
    expect(activity).toEqual({
      kind: 'created',
      actor: issued.session.user.id,
    });
  });

  it('counts unique priorities, isolates other accounts and searches literal text', async () => {
    const owner = await signIn();
    const stranger = await signIn();
    const propertyId = await newProperty(owner);
    await post(owner, 'tasks', {
      propertyId,
      title: 'Filtro 100%',
      dueOn: '2000-01-01',
      priority: 'urgent',
    }).expect(201);
    const response = await summary(owner).expect(200);
    expect(response.body.metrics).toMatchObject({
      attentionCount: 1,
      overdue: 1,
      highPriority: 0,
    });
    expect(
      (await summary(owner, { search: '%' }).expect(200)).body.tasks,
    ).toHaveLength(1);
    expect(
      (await summary(owner, { search: 'otra tarea' }).expect(200)).body.tasks,
    ).toHaveLength(0);
    const anotherProperty = await newProperty(owner);
    await post(owner, 'tasks', {
      propertyId: anotherProperty,
      title: 'Otra propiedad',
      dueOn: '2030-01-02',
      priority: 'high',
    }).expect(201);
    const filtered = await summary(owner, { propertyId }).expect(200);
    expect(filtered.body.metrics).toMatchObject({
      propertyCount: 1,
      overdue: 1,
      highPriority: 0,
    });
    expect(filtered.body.tasks).toHaveLength(1);
    expect((await summary(stranger).expect(200)).body.properties).toEqual([]);
    await summary(stranger, { propertyId }).expect(404);
    await post(stranger, 'tasks', {
      propertyId,
      title: 'No permitido',
      dueOn: '2030-01-02',
      priority: 'low',
    }).expect(404);
  });

  it('calculates monthly preventive compliance and its change without cancelled or ad-hoc tasks', async () => {
    const issued = await signIn();
    const propertyId = await newProperty(issued);
    const workspaceId = issued.session.workspaces[0].id;
    const [plan] = await harness.database.query<{ id: string }[]>(
      `
      INSERT INTO maintenance_plans (workspace_id, property_id, title, recurrence_unit,
        recurrence_interval, starts_on, next_due_at, created_by)
      VALUES ($1, $2, 'Preventivo', 'month', 1, '2000-01-01', now(), $3) RETURNING id
    `,
      [workspaceId, propertyId, issued.session.user.id],
    );
    await harness.database.query(
      `
      INSERT INTO work_orders (workspace_id, property_id, plan_id, scheduled_for, title, due_at, status, completed_at, created_by)
      SELECT $1, $2, $3, date_trunc('month', now()) + n * interval '1 day', 'Actual',
        date_trunc('month', now()) + n * interval '1 day',
        CASE WHEN n <= 2 THEN 'completed' ELSE 'pending' END,
        CASE WHEN n <= 2 THEN now() END, $4 FROM generate_series(1,4) AS g(n);
    `,
      [workspaceId, propertyId, plan.id, issued.session.user.id],
    );
    await harness.database.query(
      `
      INSERT INTO work_orders (workspace_id, property_id, plan_id, scheduled_for, title, due_at, status, completed_at, created_by)
      SELECT $1, $2, $3, date_trunc('month', now()) - interval '1 month' + n * interval '1 day', 'Anterior',
        date_trunc('month', now()) - interval '1 month' + n * interval '1 day',
        CASE WHEN n <= 3 THEN 'completed' ELSE 'pending' END,
        CASE WHEN n <= 3 THEN now() END, $4 FROM generate_series(1,4) AS g(n)
    `,
      [workspaceId, propertyId, plan.id, issued.session.user.id],
    );
    await harness.database.query(
      `
      INSERT INTO work_orders (workspace_id, property_id, title, due_at, status, completed_at, created_by)
      VALUES ($1, $2, 'Cancelada', date_trunc('month',now()), 'cancelled', NULL, $3),
        ($1, $2, 'Sin plan', date_trunc('month',now()), 'completed', now(), $3)
    `,
      [workspaceId, propertyId, issued.session.user.id],
    );
    const response = await summary(issued).expect(200);
    expect(response.body.metrics).toMatchObject({
      monthlyTasks: 5,
      completedMonthly: 3,
      compliance: 50,
      complianceChange: -25,
    });
    expect(response.body.properties[0]).toMatchObject({
      preventiveTotal: 4,
      preventiveCompleted: 2,
    });
  });

  it('enforces live viewer/member permissions and excludes archived properties', async () => {
    const owner = await signIn();
    const viewer = await signIn();
    const member = await signIn();
    const workspaceId = randomUUID();
    await harness.database.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO workspaces (id,kind,name,owner_user_id) VALUES ($1,'business','Equipo',$2)`,
        [workspaceId, owner.session.user.id],
      );
      await manager.query(
        `
        INSERT INTO workspace_members (workspace_id,user_id,role) VALUES
          ($1,$2,'admin'),($1,$3,'viewer'),($1,$4,'member')
      `,
        [
          workspaceId,
          owner.session.user.id,
          viewer.session.user.id,
          member.session.user.id,
        ],
      );
    });
    const response = await post(owner, 'properties', {
      workspaceId,
      name: 'Edificio Central',
      kind: 'building',
      address: 'Calle 1',
    }).expect(201);
    const propertyId = String(response.body.id);
    expect(
      (await summary(viewer).expect(200)).body.properties[0].canCreateTask,
    ).toBe(false);
    const task = {
      propertyId,
      title: 'Inspeccionar',
      dueOn: '2030-01-02',
      priority: 'medium',
    };
    await post(viewer, 'tasks', task).expect(403);
    await post(member, 'tasks', task).expect(201);
    await post(member, 'properties', {
      workspaceId,
      name: 'No',
      kind: 'house',
      address: 'Calle',
    }).expect(403);
    await harness.database.query(
      `UPDATE workspace_members SET status = 'inactive' WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, viewer.session.user.id],
    );
    await summary(viewer, { propertyId }).expect(404);
    await harness.database.query(
      'UPDATE properties SET archived_at = now() WHERE id = $1',
      [propertyId],
    );
    await post(owner, 'tasks', task).expect(404);
    expect((await summary(owner).expect(200)).body.metrics.propertyCount).toBe(
      0,
    );
  });

  it('rejects invalid dates, unknown fields and inaccessible workspace creation', async () => {
    const issued = await signIn();
    await summary(issued, { propertyId: 'not-a-uuid' }).expect(400);
    await post(issued, 'tasks', {
      propertyId: randomUUID(),
      title: 'Tarea',
      priority: 'high',
      dueOn: '2026-02-30',
    }).expect(400);
    await post(issued, 'tasks', {
      propertyId: randomUUID(),
      title: 'Tarea',
      priority: 'high',
      dueOn: '2030-01-01',
      workspaceId: randomUUID(),
    }).expect(400);
    await post(issued, 'properties', {
      workspaceId: randomUUID(),
      name: 'Ajena',
      kind: 'house',
      address: 'Calle',
    }).expect(404);
  });

  it('preserves the meaning of Intl numeric time-zone offsets when storing deadlines', async () => {
    const issued = await signIn();
    await harness.database.query(
      `UPDATE users SET time_zone = '+01:00' WHERE id = $1`,
      [issued.session.user.id],
    );
    const propertyId = await newProperty(issued);
    await post(issued, 'tasks', {
      propertyId,
      title: 'Revisar',
      dueOn: '2030-01-02',
      priority: 'medium',
    }).expect(201);
    const response = await summary(issued).expect(200);
    expect(response.body.timeZone).toBe('+01:00');
    expect(response.body.tasks[0].dueAt).toBe('2030-01-02T22:59:59.999Z');
    await post(issued, 'tasks', {
      propertyId,
      title: 'Fecha no valida',
      dueOn: '0000-01-01',
      priority: 'medium',
    }).expect(400);
  });

  it('completes maintenance tasks atomically with live permissions and an idempotent history', async () => {
    const owner = await signIn();
    const outsider = await signIn();
    const workspaceId = randomUUID();
    await harness.database.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO workspaces (id,kind,name,owner_user_id) VALUES ($1,'business','Equipo',$2)`,
        [workspaceId, owner.session.user.id],
      );
      await manager.query(
        `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'admin')`,
        [workspaceId, owner.session.user.id],
      );
    });
    const property = await post(owner, 'properties', {
      workspaceId,
      name: 'Edificio Central',
      kind: 'building',
      address: 'Calle de prueba 10',
    }).expect(201);
    const propertyId = String(property.body.id);
    const maintenance = '/api/maintenance/user';
    const create = await request(app.getHttpServer())
      .post(`${maintenance}/plans`)
      .set('Cookie', cookie(owner))
      .set('Origin', origin)
      .set('X-Mapreko-Request', '1')
      .send({
        propertyId,
        title: 'Revisión de filtros',
        taskTitle: 'Limpiar filtro',
        instructions: 'Seguir el manual del fabricante.',
        priority: 'medium',
        recurrenceUnit: 'month',
        recurrenceInterval: 1,
        startsOn: '2030-01-01',
        firstDueOn: '2030-01-02',
      })
      .expect(201);
    const id = String(create.body.workOrderId);
    const complete = (issued: IssuedSession) =>
      request(app.getHttpServer())
        .post(`${maintenance}/activities/${id}/complete`)
        .set('Cookie', cookie(issued))
        .set('Origin', origin)
        .set('X-Mapreko-Request', '1')
        .send({});
    await complete(outsider).expect(404);
    await harness.database.query(
      `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'viewer')`,
      [workspaceId, outsider.session.user.id],
    );
    await complete(outsider).expect(403);
    await complete(owner).expect(201);
    await complete(owner).expect(201);
    const response = await request(app.getHttpServer())
      .get(`${maintenance}/plans`)
      .set('Cookie', cookie(owner))
      .query({ month: '2030-01', propertyId })
      .expect(200);
    expect(response.body.activities[0]).toMatchObject({
      id,
      status: 'completed',
      canWrite: true,
      description: 'Seguir el manual del fabricante.',
      assignees: [],
      tasks: [{ title: 'Limpiar filtro', completed: true }],
    });
    const [history] = await harness.database.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM work_order_activities
       WHERE work_order_id = $1 AND kind = 'status_changed'`,
      [id],
    );
    expect(history.count).toBe(1);
  });
});
