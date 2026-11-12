import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

export const summaryQuerySchema = z.strictObject({
  propertyId: z.uuid().optional(),
  search: z.string().trim().max(100).optional(),
});
export const createTaskSchema = z.strictObject({
  propertyId: z.uuid(),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  dueOn: z.iso
    .date()
    .refine((value) => !value.startsWith('0000-'), 'Fecha no valida.'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
});
export const createPropertySchema = z.strictObject({
  workspaceId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['house', 'apartment', 'building', 'commercial', 'other']),
  address: z.string().trim().min(1).max(240),
});

export function dashboardInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new BadRequestException({
      message: 'Revisa los datos ingresados.',
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
  return parsed.data;
}

export type SummaryQuery = z.infer<typeof summaryQuerySchema>;
export type CreateTask = z.infer<typeof createTaskSchema>;
export type CreateProperty = z.infer<typeof createPropertySchema>;

export interface DashboardProperty {
  id: string;
  workspaceId: string;
  name: string;
  kind: CreateProperty['kind'];
  timeZone: string;
  canCreateTask: boolean;
  preventiveTotal: number;
  preventiveCompleted: number;
}

export interface DashboardTask {
  id: string;
  propertyId: string;
  propertyName: string;
  title: string;
  description: string | null;
  dueAt: Date;
  timeZone: string;
  priority: CreateTask['priority'];
  status: 'pending' | 'in_progress';
}
