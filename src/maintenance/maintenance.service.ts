import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthSession } from '../auth/auth.types.js';
import type {
  ArticleQuery,
  CreatePlan,
  MaintenanceQuery,
  PlanStatus,
} from './maintenance.types.js';

const accessibleProperties = `
  SELECT p.id, p.workspace_id, p.name, p.time_zone,
    (w.owner_user_id = $1 OR m.role <> 'viewer') AS can_write
  FROM properties p
  JOIN workspaces w ON w.id = p.workspace_id AND w.archived_at IS NULL
  JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $1 AND m.status = 'active'
  WHERE p.archived_at IS NULL
`;
const informationCenter = [
  {
    slug: 'filtros-aire-acondicionado',
    category: { slug: 'climatizacion', name: 'Climatización' },
    title: 'Cuándo revisar los filtros del aire acondicionado',
    summary:
      'Un filtro limpio ayuda a mantener el flujo de aire y a detectar cuándo hace falta atención profesional.',
    readMinutes: 3,
    content: [
      'Consulta primero el manual del fabricante: el acceso, la limpieza y el intervalo dependen del equipo.',
      'Antes de revisar un filtro, apaga el equipo usando sus controles. No retires paneles eléctricos ni partes que no estén indicadas como accesibles al usuario.',
      'Si el filtro es lavable y el manual lo permite, límpialo según esas instrucciones y deja que se seque completamente antes de reinstalarlo. Reemplaza los filtros desechables por el tamaño y tipo indicados.',
      'Detente y solicita un técnico si notas cables, partes húmedas, olor a quemado, hielo persistente o ruido fuera de lo habitual.',
    ],
    safety:
      'No manipules refrigerante ni componentes eléctricos. Si tienes alergias, asma o dudas sobre moho, consulta a un profesional.',
  },
  {
    slug: 'detectar-filtraciones',
    category: { slug: 'plomeria', name: 'Plomería y humedad' },
    title: 'Cómo detectar señales tempranas de filtración',
    summary:
      'Manchas, pintura abombada y humedad persistente pueden indicar que conviene investigar una filtración.',
    readMinutes: 4,
    content: [
      'Observa techos, paredes, gabinetes y áreas alrededor de tuberías, especialmente después de lluvia o de usar instalaciones cercanas.',
      'Registra cuándo apareció la señal y toma una fotografía desde una distancia segura. No perfores paredes ni techos para buscar el origen.',
      'Si la fuga es visible, cierra la llave de paso solo si es accesible y sabes identificarla. Aleja objetos y avisa al propietario o administrador.',
      'Contacta con un profesional si la humedad crece, hay agua cerca de enchufes, aparece olor persistente o se desprenden materiales.',
    ],
    safety:
      'No toques agua que pueda estar en contacto con electricidad. Si hay peligro inmediato, aléjate del área y contacta los servicios locales de emergencia.',
  },
  {
    slug: 'detectores-humo',
    category: { slug: 'seguridad', name: 'Seguridad del hogar' },
    title: 'Revisión segura de detectores de humo',
    summary:
      'Una comprobación periódica y seguir las instrucciones del fabricante ayudan a mantener los detectores listos.',
    readMinutes: 3,
    content: [
      'Sigue las indicaciones del fabricante y las normas de tu localidad para la frecuencia de revisión y reemplazo.',
      'Usa el botón de prueba del dispositivo cuando las instrucciones lo permitan. No pruebes el detector con fuego, humo ni aerosoles no autorizados.',
      'Mantén libres las aberturas del dispositivo y no lo cubras con pintura o decoraciones.',
      'Si el detector está cableado, dañado o instalado en un sitio de difícil acceso, solicita ayuda a una persona calificada.',
    ],
    safety:
      'No desconectes permanentemente un detector. Si una alarma indica peligro, sigue el plan de evacuación y llama a los servicios locales.',
  },
  {
    slug: 'cuidado-areas-exteriores',
    category: { slug: 'exterior', name: 'Exterior y temporada de lluvias' },
    title: 'Preparar el exterior antes de lluvias intensas',
    summary:
      'Revisar a distancia drenajes visibles y asegurar objetos sueltos ayuda a reducir riesgos ante mal tiempo.',
    readMinutes: 4,
    content: [
      'Consulta los avisos meteorológicos oficiales y las recomendaciones de las autoridades de tu zona.',
      'Desde un lugar seguro, observa si los desagües accesibles están obstruidos por hojas. No subas a techos ni uses escaleras con lluvia o viento.',
      'Guarda objetos livianos que puedan desplazarse por el viento y revisa que puertas y ventanas cierren correctamente.',
      'Después del evento, espera a que las condiciones sean seguras. Solicita una inspección profesional si observas daños, cables caídos o filtraciones.',
    ],
    safety:
      'Evita caminar o conducir por agua acumulada, y no te acerques a cables caídos. Sigue las alertas oficiales.',
  },
  {
    slug: 'mantenimiento-calentador',
    category: { slug: 'equipos', name: 'Equipos e instalaciones' },
    title: 'Cuándo solicitar revisión de un calentador de agua',
    summary:
      'Ruidos nuevos, pérdidas o cambios persistentes de temperatura son razones para consultar el manual o a un técnico.',
    readMinutes: 3,
    content: [
      'Consulta el manual para conocer las revisiones permitidas para tu modelo y el intervalo recomendado.',
      'Observa desde el exterior si hay humedad, corrosión visible o cambios inusuales. No retires cubiertas.',
      'No ajustes válvulas de seguridad, presión o combustión. Esas tareas corresponden a personal calificado.',
      'Solicita una revisión si hay goteo, olor inusual, agua demasiado caliente o interrupciones repetidas.',
    ],
    safety:
      'Si percibes olor a gas, no enciendas interruptores ni llamas. Sal del área y comunícate con el proveedor de gas o los servicios de emergencia locales desde un lugar seguro.',
  },
];

@Injectable()
export class MaintenanceService {
  constructor(private readonly database: DataSource) {}

  private requireUser(session: AuthSession): void {
    if (session.application !== 'user')
      throw new ForbiddenException('Esta pantalla pertenece a Mi espacio.');
  }

  async listPlans(session: AuthSession, query: MaintenanceQuery) {
    this.requireUser(session);
    const now = new Date();
    const month =
      query.month ??
      new Intl.DateTimeFormat('en-CA', {
        timeZone: session.user.timeZone,
        year: 'numeric',
        month: '2-digit',
      }).format(now);
    const plans = await this.database.query<
      {
        id: string;
        workspaceId: string;
        propertyId: string;
        propertyName: string;
        title: string;
        description: string | null;
        priority: string;
        recurrenceUnit: string;
        recurrenceInterval: number;
        startsOn: string;
        nextDueAt: Date;
        timeZone: string;
        estimatedMinutes: number | null;
        status: string;
        canWrite: boolean;
        tasks: Array<{ title: string; instructions: string | null }>;
      }[]
    >(
      `
      WITH visible AS (${accessibleProperties})
      SELECT mp.id, mp.workspace_id AS "workspaceId", mp.property_id AS "propertyId",
        p.name AS "propertyName", mp.title, mp.description, mp.priority,
        mp.recurrence_unit AS "recurrenceUnit", mp.recurrence_interval AS "recurrenceInterval",
        mp.starts_on AS "startsOn", mp.next_due_at AS "nextDueAt", mp.time_zone AS "timeZone",
        mp.estimated_minutes AS "estimatedMinutes", mp.status, p.can_write AS "canWrite",
        COALESCE(json_agg(json_build_object('title', pt.title, 'instructions', pt.instructions)
          ORDER BY pt.position) FILTER (WHERE pt.id IS NOT NULL), '[]'::json) AS tasks
      FROM maintenance_plans mp
      JOIN visible p ON p.id = mp.property_id AND p.workspace_id = mp.workspace_id
      LEFT JOIN maintenance_plan_tasks pt ON pt.workspace_id = mp.workspace_id AND pt.plan_id = mp.id
      WHERE ($2::uuid IS NULL OR mp.property_id = $2) AND mp.status <> 'archived'
      GROUP BY mp.id, p.name, p.can_write
      ORDER BY CASE mp.status WHEN 'active' THEN 0 ELSE 1 END, mp.next_due_at, mp.id
    `,
      [session.user.id, query.propertyId ?? null],
    );
    if (query.propertyId && plans.length === 0) {
      const [visible] = await this.database.query<{ id: string }[]>(
        `WITH visible AS (${accessibleProperties}) SELECT id FROM visible WHERE id = $2`,
        [session.user.id, query.propertyId],
      );
      if (!visible) throw new NotFoundException('Propiedad no disponible.');
    }
    const activities = await this.database.query<
      {
        id: string;
        propertyId: string;
        propertyName: string;
        title: string;
        dueAt: Date;
        timeZone: string;
        status: string;
        priority: string;
        planId: string | null;
        planTitle: string | null;
        description: string | null;
        canWrite: boolean;
        assignees: { id: string; name: string }[];
        tasks: {
          id: string;
          title: string;
          instructions: string | null;
          completed: boolean;
        }[];
      }[]
    >(
      `
      WITH visible AS (${accessibleProperties}), bounds AS (
        SELECT $2::date AS first_day, ($2::date + interval '1 month')::date AS next_month
      )
      SELECT wo.id, p.id AS "propertyId", p.name AS "propertyName", wo.title, wo.due_at AS "dueAt",
        p.time_zone AS "timeZone", wo.status, wo.priority, wo.plan_id AS "planId", mp.title AS "planTitle",
        wo.description, p.can_write AS "canWrite",
        COALESCE((SELECT json_agg(json_build_object('id', u.id,
          'name', COALESCE(NULLIF(u.display_name, ''), NULLIF(trim(concat_ws(' ', u.given_name, u.family_name)), ''), u.email))
          ORDER BY u.id)
          FROM work_order_assignees a JOIN users u ON u.id = a.user_id
          WHERE a.workspace_id = wo.workspace_id AND a.work_order_id = wo.id), '[]'::json) AS assignees,
        COALESCE((SELECT json_agg(json_build_object('id', t.id, 'title', t.title,
          'instructions', t.instructions, 'completed', t.completed_at IS NOT NULL) ORDER BY t.position)
          FROM work_order_tasks t WHERE t.workspace_id = wo.workspace_id AND t.work_order_id = wo.id),
          '[]'::json) AS tasks
      FROM work_orders wo JOIN visible p ON p.id = wo.property_id AND p.workspace_id = wo.workspace_id
      LEFT JOIN maintenance_plans mp ON mp.id = wo.plan_id AND mp.workspace_id = wo.workspace_id
      CROSS JOIN bounds
      WHERE wo.status <> 'cancelled' AND ($3::uuid IS NULL OR p.id = $3)
        AND (wo.due_at AT TIME ZONE p.time_zone)::date >= first_day
        AND (wo.due_at AT TIME ZONE p.time_zone)::date < next_month
      ORDER BY wo.due_at, wo.id
    `,
      [session.user.id, `${month}-01`, query.propertyId ?? null],
    );
    const properties = await this.database.query<
      { id: string; name: string }[]
    >(
      `
      WITH visible AS (${accessibleProperties})
      SELECT id, name FROM visible ORDER BY name, id
    `,
      [session.user.id],
    );
    return {
      month,
      properties,
      plans,
      activities,
      metrics: {
        active: plans.filter((plan) => plan.status === 'active').length,
        paused: plans.filter((plan) => plan.status === 'paused').length,
        dueThisMonth: plans.filter((plan) => {
          const date = new Intl.DateTimeFormat('en-CA', {
            timeZone: plan.timeZone,
            year: 'numeric',
            month: '2-digit',
          }).format(plan.nextDueAt);
          return date === month;
        }).length,
        completedThisMonth: activities.filter(
          (activity) => activity.status === 'completed',
        ).length,
      },
    };
  }

  async createPlan(session: AuthSession, input: CreatePlan) {
    this.requireUser(session);
    if (input.firstDueOn < input.startsOn)
      throw new BadRequestException(
        'La primera fecha debe ser igual o posterior al inicio.',
      );
    return this.database.transaction(async (manager) => {
      const [property] = await manager.query<
        {
          id: string;
          workspaceId: string;
          timeZone: string;
          canWrite: boolean;
        }[]
      >(
        `
        SELECT p.id, p.workspace_id AS "workspaceId", p.time_zone AS "timeZone",
          (w.owner_user_id = $1 OR m.role <> 'viewer') AS "canWrite"
        FROM properties p
        JOIN workspaces w ON w.id = p.workspace_id AND w.archived_at IS NULL
        JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $1 AND m.status = 'active'
        WHERE p.id = $2 AND p.archived_at IS NULL
        FOR SHARE OF p, w, m
      `,
        [session.user.id, input.propertyId],
      );
      if (!property) throw new NotFoundException('Propiedad no disponible.');
      if (!property.canWrite)
        throw new ForbiddenException(
          'Tu acceso a este espacio es de solo lectura.',
        );
      const zone = property.timeZone.startsWith('+')
        ? `-${property.timeZone.slice(1)}`
        : property.timeZone.startsWith('-')
          ? `+${property.timeZone.slice(1)}`
          : property.timeZone;
      const [plan] = await manager.query<{ id: string }[]>(
        `
        INSERT INTO maintenance_plans (workspace_id, property_id, title, description, priority,
          recurrence_unit, recurrence_interval, starts_on, next_due_at, time_zone, estimated_minutes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
          ($9::date + interval '1 day' - interval '1 millisecond') AT TIME ZONE $10,
          $11,$12,$13) RETURNING id
      `,
        [
          property.workspaceId,
          property.id,
          input.title,
          input.description || null,
          input.priority,
          input.recurrenceUnit,
          input.recurrenceInterval,
          input.startsOn,
          input.firstDueOn,
          zone,
          property.timeZone,
          input.estimatedMinutes ?? null,
          session.user.id,
        ],
      );
      await manager.query(
        `
        INSERT INTO maintenance_plan_tasks (workspace_id, plan_id, title, instructions, position)
        VALUES ($1,$2,$3,$4,0)
      `,
        [
          property.workspaceId,
          plan.id,
          input.taskTitle,
          input.instructions || null,
        ],
      );
      const [order] = await manager.query<{ id: string }[]>(
        `
        INSERT INTO work_orders (workspace_id, property_id, plan_id, scheduled_for, title, description,
          priority, due_at, created_by)
        SELECT $1,$2,$3,mp.next_due_at,$4,$5,$6,mp.next_due_at,$7
        FROM maintenance_plans mp WHERE mp.id = $3 RETURNING id
      `,
        [
          property.workspaceId,
          property.id,
          plan.id,
          input.taskTitle,
          input.instructions || input.description || null,
          input.priority,
          session.user.id,
        ],
      );
      await manager.query(
        `
        INSERT INTO work_order_tasks (workspace_id, work_order_id, title, instructions, position)
        VALUES ($1,$2,$3,$4,0)
      `,
        [
          property.workspaceId,
          order.id,
          input.taskTitle,
          input.instructions || null,
        ],
      );
      await manager.query(
        `
        INSERT INTO work_order_activities (workspace_id, work_order_id, actor_user_id, kind, body)
        VALUES ($1,$2,$3,'created','Primera tarea del plan de mantenimiento.')
      `,
        [property.workspaceId, order.id, session.user.id],
      );
      return { id: plan.id, workOrderId: order.id };
    });
  }

  async updatePlanStatus(
    session: AuthSession,
    planId: string,
    status: PlanStatus['status'],
  ) {
    this.requireUser(session);
    return this.database.transaction(async (manager) => {
      const [plan] = await manager.query<{ id: string; canWrite: boolean }[]>(
        `
        SELECT mp.id, (w.owner_user_id = $1 OR m.role <> 'viewer') AS "canWrite"
        FROM maintenance_plans mp
        JOIN properties p ON p.id = mp.property_id AND p.workspace_id = mp.workspace_id AND p.archived_at IS NULL
        JOIN workspaces w ON w.id = mp.workspace_id AND w.archived_at IS NULL
        JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $1 AND m.status = 'active'
        WHERE mp.id = $2 AND mp.status <> 'archived'
        FOR UPDATE OF mp
        FOR SHARE OF p, w, m
      `,
        [session.user.id, planId],
      );
      if (!plan) throw new NotFoundException('Plan no disponible.');
      if (!plan.canWrite)
        throw new ForbiddenException(
          'Tu acceso a este espacio es de solo lectura.',
        );
      await manager.query(
        'UPDATE maintenance_plans SET status = $2 WHERE id = $1',
        [planId, status],
      );
      return { id: planId, status };
    });
  }

  async completeActivity(session: AuthSession, id: string) {
    this.requireUser(session);
    return this.database.transaction(async (manager) => {
      const [order] = await manager.query<
        { workspaceId: string; canWrite: boolean; status: string }[]
      >(
        `
        SELECT wo.workspace_id AS "workspaceId", wo.status,
          (w.owner_user_id = $1 OR m.role <> 'viewer') AS "canWrite"
        FROM work_orders wo
        JOIN properties p ON p.id = wo.property_id AND p.workspace_id = wo.workspace_id AND p.archived_at IS NULL
        JOIN workspaces w ON w.id = wo.workspace_id AND w.archived_at IS NULL
        JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $1 AND m.status = 'active'
        WHERE wo.id = $2 AND wo.status <> 'cancelled'
        FOR UPDATE OF wo
        FOR SHARE OF p, w, m
        `,
        [session.user.id, id],
      );
      if (!order) throw new NotFoundException('Tarea no disponible.');
      if (!order.canWrite)
        throw new ForbiddenException(
          'Tu acceso a este espacio es de solo lectura.',
        );
      if (order.status === 'completed') return { id, status: 'completed' };
      await manager.query(
        `UPDATE work_orders SET status = 'completed', completed_at = clock_timestamp()
         WHERE id = $1 AND workspace_id = $2`,
        [id, order.workspaceId],
      );
      await manager.query(
        `UPDATE work_order_tasks SET completed_at = clock_timestamp(), completed_by = $3
         WHERE work_order_id = $1 AND workspace_id = $2 AND completed_at IS NULL`,
        [id, order.workspaceId, session.user.id],
      );
      await manager.query(
        `INSERT INTO work_order_activities (workspace_id, work_order_id, actor_user_id, kind, body)
         VALUES ($1,$2,$3,'status_changed','Tarea marcada como completada.')`,
        [order.workspaceId, id, session.user.id],
      );
      return { id, status: 'completed' };
    });
  }

  listArticles(session: AuthSession, query: ArticleQuery) {
    this.requireUser(session);
    const search = query.search?.toLocaleLowerCase();
    const articles = informationCenter.filter(
      (article) =>
        (!query.category || article.category.slug === query.category) &&
        (!search ||
          `${article.title} ${article.summary} ${article.category.name}`
            .toLocaleLowerCase()
            .includes(search)),
    );
    return {
      categories: [
        ...new Map(
          informationCenter.map((article) => [
            article.category.slug,
            article.category,
          ]),
        ).values(),
      ],
      articles: articles.map(
        ({ content: _content, safety: _safety, ...article }) => article,
      ),
    };
  }

  article(session: AuthSession, slug: string) {
    this.requireUser(session);
    const article = informationCenter.find((item) => item.slug === slug);
    if (!article) throw new NotFoundException('Guia no disponible.');
    return article;
  }
}
