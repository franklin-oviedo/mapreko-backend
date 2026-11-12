import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

export const maintenanceQuerySchema = z.strictObject({
  propertyId: z.uuid().optional(),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes no valido.')
    .optional(),
});
export const createPlanSchema = z.strictObject({
  propertyId: z.uuid(),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  taskTitle: z.string().trim().min(1).max(160),
  instructions: z.string().trim().max(2000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  recurrenceUnit: z.enum(['day', 'week', 'month', 'year']),
  recurrenceInterval: z.number().int().min(1).max(365),
  startsOn: z.iso.date().refine((value) => !value.startsWith('0000-')),
  firstDueOn: z.iso.date().refine((value) => !value.startsWith('0000-')),
  estimatedMinutes: z.number().int().min(1).max(10080).optional(),
});
export const planStatusSchema = z.strictObject({
  status: z.enum(['active', 'paused']),
});
export const maintenanceArticleQuerySchema = z.strictObject({
  search: z.string().trim().max(100).optional(),
  category: z
    .string()
    .regex(/^[a-z0-9-]{1,60}$/)
    .optional(),
});

export function maintenanceInput<T>(schema: z.ZodType<T>, value: unknown): T {
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

export type MaintenanceQuery = z.infer<typeof maintenanceQuerySchema>;
export type CreatePlan = z.infer<typeof createPlanSchema>;
export type PlanStatus = z.infer<typeof planStatusSchema>;
export type ArticleQuery = z.infer<typeof maintenanceArticleQuerySchema>;
