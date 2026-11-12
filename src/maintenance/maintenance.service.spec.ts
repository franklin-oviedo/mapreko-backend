import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { AuthSession } from '../auth/auth.types.js';
import { MaintenanceService } from './maintenance.service.js';
import { createPlanSchema, maintenanceInput } from './maintenance.types.js';

const userSession: AuthSession = {
  id: 'session-id',
  application: 'user',
  expiresAt: new Date('2026-12-01T00:00:00.000Z'),
  user: {
    id: 'user-id',
    email: 'person@example.test',
    emailVerified: true,
    givenName: 'Test',
    familyName: 'User',
    displayName: 'Test User',
    avatarUrl: null,
    phone: null,
    locale: 'es',
    timeZone: 'America/Santo_Domingo',
  },
  roles: ['user'],
  permissions: [],
  workspaces: [],
};
const input = maintenanceInput(createPlanSchema, {
  propertyId: '9ef24d81-5ab5-4db4-b189-a9e79897d004',
  title: 'Revisión preventiva',
  taskTitle: 'Revisar el filtro',
  priority: 'medium',
  recurrenceUnit: 'month',
  recurrenceInterval: 1,
  startsOn: '2026-11-12',
  firstDueOn: '2026-11-13',
});

describe('MaintenanceService', () => {
  it('rejects a first due date before the start date as bad input before opening a transaction', async () => {
    const transaction = vi.fn();
    const service = new MaintenanceService({
      transaction,
    } as unknown as DataSource);

    await expect(
      service.createPlan(userSession, { ...input, startsOn: '2026-11-14' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('creates a plan, its reusable task and first order inside one transaction', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: input.propertyId,
          workspaceId: 'workspace-id',
          timeZone: 'UTC',
          canWrite: true,
        },
      ])
      .mockResolvedValueOnce([{ id: 'plan-id' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'work-order-id' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const transaction = vi.fn(
      (callback: (manager: EntityManager) => Promise<unknown>) =>
        callback({ query } as unknown as EntityManager),
    );
    const service = new MaintenanceService({
      transaction,
    } as unknown as DataSource);

    await expect(service.createPlan(userSession, input)).resolves.toEqual({
      id: 'plan-id',
      workOrderId: 'work-order-id',
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(6);
    expect(query.mock.calls[0][0]).toContain('FOR SHARE OF p, w, m');
    expect(query.mock.calls[1][0]).toContain('INSERT INTO maintenance_plans');
    expect(query.mock.calls[2][0]).toContain(
      'INSERT INTO maintenance_plan_tasks',
    );
    expect(query.mock.calls[3][0]).toContain('INSERT INTO work_orders');
    expect(query.mock.calls[4][0]).toContain('INSERT INTO work_order_tasks');
    expect(query.mock.calls[5][0]).toContain(
      'INSERT INTO work_order_activities',
    );
  });

  it('does not mutate a plan for a read-only workspace member', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'plan-id', canWrite: false }]);
    const transaction = vi.fn(
      (callback: (manager: EntityManager) => Promise<unknown>) =>
        callback({ query } as unknown as EntityManager),
    );
    const service = new MaintenanceService({
      transaction,
    } as unknown as DataSource);

    await expect(
      service.updatePlanStatus(userSession, 'plan-id', 'paused'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(query).toHaveBeenCalledOnce();
  });

  it('passes the authenticated user UUID to the calendar visibility query', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const service = new MaintenanceService({ query } as unknown as DataSource);

    await service.listPlans(userSession, { month: '2026-11' });

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][1]).toEqual([
      userSession.user.id,
      '2026-11-01',
      null,
    ]);
  });

  it('completes an accessible task and its steps with one history entry in a transaction', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        { workspaceId: 'workspace-id', canWrite: true, status: 'pending' },
      ])
      .mockResolvedValue([]);
    const transaction = vi.fn(
      (callback: (manager: EntityManager) => Promise<unknown>) =>
        callback({ query } as unknown as EntityManager),
    );
    const service = new MaintenanceService({
      transaction,
    } as unknown as DataSource);
    await expect(
      service.completeActivity(userSession, 'task-id'),
    ).resolves.toEqual({
      id: 'task-id',
      status: 'completed',
    });
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[0][1]).toEqual([userSession.user.id, 'task-id']);
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE OF wo');
    expect(query.mock.calls[2][1]).toEqual([
      'task-id',
      'workspace-id',
      userSession.user.id,
    ]);
    expect(query.mock.calls[3][0]).toContain(
      'INSERT INTO work_order_activities',
    );
  });

  it('blocks viewers and makes repeated completion idempotent', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        { workspaceId: 'workspace-id', canWrite: false, status: 'pending' },
      ]);
    const transaction = vi.fn(
      (callback: (manager: EntityManager) => Promise<unknown>) =>
        callback({ query } as unknown as EntityManager),
    );
    const service = new MaintenanceService({
      transaction,
    } as unknown as DataSource);
    await expect(
      service.completeActivity(userSession, 'task-id'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(query).toHaveBeenCalledOnce();
    query
      .mockReset()
      .mockResolvedValueOnce([
        { workspaceId: 'workspace-id', canWrite: true, status: 'completed' },
      ]);
    await expect(
      service.completeActivity(userSession, 'task-id'),
    ).resolves.toEqual({ id: 'task-id', status: 'completed' });
    expect(query).toHaveBeenCalledOnce();
  });

  it('returns only published article summaries in the list and blocks admin sessions', () => {
    const service = new MaintenanceService({} as DataSource);
    const listing = service.listArticles(userSession, {});
    expect(listing.articles.length).toBeGreaterThan(0);
    expect(listing.articles[0]).not.toHaveProperty('content');
    expect(listing.articles[0]).not.toHaveProperty('safety');
    expect(() =>
      service.listArticles({ ...userSession, application: 'admin' }, {}),
    ).toThrow(ForbiddenException);
  });
});
