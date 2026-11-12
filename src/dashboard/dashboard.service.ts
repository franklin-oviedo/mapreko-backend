import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthSession } from '../auth/auth.types.js';
import type {
  CreateProperty,
  CreateTask,
  DashboardProperty,
  DashboardTask,
  SummaryQuery,
} from './dashboard.types.js';

// Every read and write checks live membership, not workspace IDs supplied by the browser.
const visibleProperties = `
  SELECT p.*, (w.owner_user_id = $1 OR m.role <> 'viewer') AS can_write
  FROM properties p
  JOIN workspaces w ON w.id = p.workspace_id AND w.archived_at IS NULL
  JOIN workspace_members m ON m.workspace_id = w.id
    AND m.user_id = $1 AND m.status = 'active'
  WHERE p.archived_at IS NULL
`;

function databaseTimeZone(value: string): string {
  const zone = new Intl.DateTimeFormat('en', {
    timeZone: value,
  }).resolvedOptions().timeZone;
  // PostgreSQL's numeric zone strings use POSIX signs, opposite to Intl offsets.
  return zone.startsWith('+')
    ? `-${zone.slice(1)}`
    : zone.startsWith('-')
      ? `+${zone.slice(1)}`
      : zone;
}

@Injectable()
export class DashboardService {
  constructor(private readonly database: DataSource) {}

  private requireUser(session: AuthSession): void {
    if (session.application !== 'user')
      throw new ForbiddenException(
        'El resumen pertenece al entorno Mi espacio.',
      );
  }

  async summary(session: AuthSession, query: SummaryQuery) {
    this.requireUser(session);
    return this.database.transaction('REPEATABLE READ', async (manager) => {
      const [{ now }] = await manager.query<{ now: Date }[]>(
        'SELECT now() AS now',
      );
      const zone = databaseTimeZone(session.user.timeZone);
      const properties = await manager.query<DashboardProperty[]>(
        `
        WITH visible AS (${visibleProperties})
        SELECT p.id, p.workspace_id AS "workspaceId", p.name, p.kind,
          p.time_zone AS "timeZone", p.can_write AS "canCreateTask",
          count(t.id)::int AS "preventiveTotal",
          count(t.id) FILTER (WHERE t.status = 'completed')::int AS "preventiveCompleted"
        FROM visible p LEFT JOIN work_orders t ON t.property_id = p.id AND t.workspace_id = p.workspace_id
          AND t.plan_id IS NOT NULL AND t.status <> 'cancelled'
          AND date_trunc('month', t.due_at AT TIME ZONE $3) = date_trunc('month', $2::timestamptz AT TIME ZONE $3)
        GROUP BY p.id, p.workspace_id, p.name, p.kind, p.time_zone, p.can_write
        ORDER BY p.name, p.id
      `,
        [session.user.id, now, zone],
      );
      if (
        query.propertyId &&
        !properties.some((property) => property.id === query.propertyId)
      )
        throw new NotFoundException('Propiedad no disponible.');

      const [counts] = await manager.query<
        {
          monthlyTasks: number;
          completedMonthly: number;
          overdue: number;
          highPriority: number;
          preventiveTotal: number;
          preventiveCompleted: number;
          previousTotal: number;
          previousCompleted: number;
          pendingTasks: number;
        }[]
      >(
        `
        WITH visible AS (${visibleProperties}), scoped AS (
          SELECT t.*, date_trunc('month', t.due_at AT TIME ZONE $3) AS due_month
          FROM work_orders t JOIN visible p ON p.id = t.property_id AND p.workspace_id = t.workspace_id
          WHERE ($4::uuid IS NULL OR p.id = $4) AND t.status <> 'cancelled'
        ), bounds AS (
          SELECT date_trunc('month', $2::timestamptz AT TIME ZONE $3) AS month
        )
        SELECT
          count(*) FILTER (WHERE due_month = month)::int AS "monthlyTasks",
          count(*) FILTER (WHERE due_month = month AND status = 'completed')::int AS "completedMonthly",
          count(*) FILTER (WHERE status IN ('pending','in_progress') AND due_at < $2)::int AS overdue,
          count(*) FILTER (WHERE status IN ('pending','in_progress') AND due_at >= $2 AND priority IN ('high','urgent'))::int AS "highPriority",
          count(*) FILTER (WHERE due_month = month AND plan_id IS NOT NULL)::int AS "preventiveTotal",
          count(*) FILTER (WHERE due_month = month AND plan_id IS NOT NULL AND status = 'completed')::int AS "preventiveCompleted",
          count(*) FILTER (WHERE due_month = month - interval '1 month' AND plan_id IS NOT NULL)::int AS "previousTotal",
          count(*) FILTER (WHERE due_month = month - interval '1 month' AND plan_id IS NOT NULL AND status = 'completed')::int AS "previousCompleted",
          count(*) FILTER (WHERE status IN ('pending','in_progress'))::int AS "pendingTasks"
        FROM scoped CROSS JOIN bounds
      `,
        [session.user.id, now, zone, query.propertyId ?? null],
      );
      const tasks = await manager.query<DashboardTask[]>(
        `
        WITH visible AS (${visibleProperties})
        SELECT t.id, p.id AS "propertyId", p.name AS "propertyName", t.title, t.description,
          t.due_at AS "dueAt", p.time_zone AS "timeZone", t.priority, t.status
        FROM work_orders t JOIN visible p ON p.id = t.property_id AND p.workspace_id = t.workspace_id
        WHERE t.status IN ('pending','in_progress') AND ($3::uuid IS NULL OR p.id = $3)
          AND strpos(lower(t.title || ' ' || p.name), lower($4)) > 0
        ORDER BY (t.due_at < $2) DESC,
          CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
          t.due_at, t.id LIMIT 50
      `,
        [session.user.id, now, query.propertyId ?? null, query.search ?? ''],
      );
      const selected = properties.filter(
        (p) => !query.propertyId || p.id === query.propertyId,
      );
      const compliance = counts.preventiveTotal
        ? Math.round(
            (100 * counts.preventiveCompleted) / counts.preventiveTotal,
          )
        : null;
      const previous = counts.previousTotal
        ? Math.round((100 * counts.previousCompleted) / counts.previousTotal)
        : null;
      return {
        generatedAt: now,
        timeZone: session.user.timeZone,
        properties,
        tasks,
        metrics: {
          propertyCount: selected.length,
          buildingCount: selected.filter((p) => p.kind === 'building').length,
          housingCount: selected.filter(
            (p) => p.kind === 'house' || p.kind === 'apartment',
          ).length,
          otherCount: selected.filter(
            (p) => p.kind === 'commercial' || p.kind === 'other',
          ).length,
          monthlyTasks: counts.monthlyTasks,
          completedMonthly: counts.completedMonthly,
          overdue: counts.overdue,
          highPriority: counts.highPriority,
          attentionCount: counts.overdue + counts.highPriority,
          pendingTasks: counts.pendingTasks,
          compliance,
          complianceChange:
            compliance !== null && previous !== null
              ? compliance - previous
              : null,
        },
      };
    });
  }

  async createTask(session: AuthSession, input: CreateTask) {
    this.requireUser(session);
    return this.database.transaction(async (manager) => {
      const [property] = await manager.query<
        { workspaceId: string; timeZone: string; canWrite: boolean }[]
      >(
        `
        SELECT p.workspace_id AS "workspaceId", p.time_zone AS "timeZone",
          (w.owner_user_id = $1 OR m.role <> 'viewer') AS "canWrite"
        FROM properties p JOIN workspaces w ON w.id = p.workspace_id AND w.archived_at IS NULL
        JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $1 AND m.status = 'active'
        WHERE p.id = $2 AND p.archived_at IS NULL FOR SHARE OF p, w, m
      `,
        [session.user.id, input.propertyId],
      );
      if (!property) throw new NotFoundException('Propiedad no disponible.');
      if (!property.canWrite)
        throw new ForbiddenException(
          'Tu acceso a este espacio es de solo lectura.',
        );
      const [task] = await manager.query<{ id: string }[]>(
        `
        INSERT INTO work_orders (workspace_id, property_id, title, description, due_at, priority, created_by)
        VALUES ($1, $2, $3, $4, ($5::date + interval '1 day' - interval '1 millisecond') AT TIME ZONE $6, $7, $8)
        RETURNING id
      `,
        [
          property.workspaceId,
          input.propertyId,
          input.title,
          input.description || null,
          input.dueOn,
          databaseTimeZone(property.timeZone),
          input.priority,
          session.user.id,
        ],
      );
      await manager.query(
        `
        INSERT INTO work_order_activities (workspace_id, work_order_id, actor_user_id, kind, body)
        VALUES ($1, $2, $3, 'created', 'Tarea creada desde el resumen.')
      `,
        [property.workspaceId, task.id, session.user.id],
      );
      return task;
    });
  }

  async createProperty(session: AuthSession, input: CreateProperty) {
    this.requireUser(session);
    return this.database.transaction(async (manager) => {
      const [access] = await manager.query<{ canWrite: boolean }[]>(
        `
        SELECT (w.owner_user_id = $1 OR m.role = 'admin') AS "canWrite"
        FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
          AND m.user_id = $1 AND m.status = 'active'
        WHERE w.id = $2 AND w.archived_at IS NULL FOR SHARE OF w, m
      `,
        [session.user.id, input.workspaceId],
      );
      if (!access) throw new NotFoundException('Espacio no disponible.');
      if (!access.canWrite)
        throw new ForbiddenException(
          'Solo el propietario o un administrador puede registrar propiedades.',
        );
      const [property] = await manager.query<{ id: string }[]>(
        `
        INSERT INTO properties (workspace_id, name, kind, address_line1, time_zone)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `,
        [
          input.workspaceId,
          input.name,
          input.kind,
          input.address,
          session.user.timeZone,
        ],
      );
      return property;
    });
  }
}
