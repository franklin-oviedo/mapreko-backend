import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

export const applicationSchema = z.enum(['user', 'admin']);
export type Application = z.infer<typeof applicationSchema>;
export const phonePattern = /^(?=(?:\D*\d){7,15}\D*$)\+?[0-9 ()-]{7,25}$/;

export function parseApplication(value: unknown): Application {
  const parsed = applicationSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Aplicacion no valida.');
  return parsed.data;
}

export const profileSchema = z
  .strictObject({
    givenName: z.string().trim().min(1).max(80).nullable().optional(),
    familyName: z.string().trim().min(1).max(80).nullable().optional(),
    displayName: z.string().trim().min(1).max(120).nullable().optional(),
    phone: z.string().trim().regex(phonePattern).nullable().optional(),
    locale: z.enum(['es', 'en']).optional(),
    timeZone: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('es', { timeZone: value });
          return true;
        } catch (error) {
          if (error instanceof RangeError) return false;
          throw error;
        }
      }, 'Zona horaria no valida.')
      .optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    'No hay cambios para guardar.',
  );
export type ProfileUpdate = z.infer<typeof profileSchema>;

export interface GoogleProfile {
  subject: string;
  email: string;
  givenName: string | null;
  familyName: string | null;
  avatarUrl: string | null;
}

export interface UserProfile {
  id: string;
  email: string;
  emailVerified: boolean;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  phone: string | null;
  locale: string;
  timeZone: string;
}

export interface WorkspaceAccess {
  id: string;
  name: string;
  kind: 'personal' | 'business';
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

export interface AuthSession {
  id: string;
  application: Application;
  expiresAt: Date;
  user: UserProfile;
  roles: string[];
  permissions: string[];
  workspaces: WorkspaceAccess[];
}

export interface IssuedSession {
  session: AuthSession;
  accessToken: string;
  refreshToken: string;
}

export const userColumns = `
  u.id, u.email, u.email_verified AS "emailVerified",
  u.given_name AS "givenName", u.family_name AS "familyName",
  u.display_name AS "displayName", u.avatar_url AS "avatarUrl",
  u.phone, u.locale, u.time_zone AS "timeZone"
`;
