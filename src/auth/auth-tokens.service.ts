import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import { AuthSettings } from './auth.settings.js';
import { applicationSchema } from './auth.types.js';
import type { Application, AuthSession } from './auth.types.js';

const accessSchema = z.object({
  sub: z.uuid(),
  sid: z.uuid(),
  application: applicationSchema,
});
const flowSchema = z.object({
  state: z.string().min(32).max(128),
  nonce: z.string().min(32).max(128),
  verifier: z.string().min(43).max(128),
  application: applicationSchema,
});
export type OAuthFlow = z.infer<typeof flowSchema>;

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class AuthTokens {
  constructor(
    private readonly jwt: JwtService,
    private readonly settings: AuthSettings,
  ) {}

  access(session: AuthSession): Promise<string> {
    return this.jwt.signAsync(
      {
        sub: session.user.id,
        sid: session.id,
        application: session.application,
      },
      {
        secret: this.settings.secret,
        algorithm: 'HS256',
        issuer: 'mapreko',
        audience: 'mapreko-access',
        expiresIn: 15 * 60,
      },
    );
  }

  flow(flow: OAuthFlow): Promise<string> {
    return this.jwt.signAsync(flow, {
      secret: this.settings.secret,
      algorithm: 'HS256',
      issuer: 'mapreko',
      audience: 'mapreko-oauth',
      expiresIn: 10 * 60,
    });
  }

  private async verify(
    token: string,
    audience: string,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.settings.secret,
        algorithms: ['HS256'],
        issuer: 'mapreko',
        audience,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(
          error.name,
        )
      ) {
        throw new UnauthorizedException(
          'La sesion no es valida o ha expirado.',
        );
      }
      throw error;
    }
  }

  async readAccess(token: string, application: Application) {
    const parsed = accessSchema.safeParse(
      await this.verify(token, 'mapreko-access'),
    );
    if (!parsed.success || parsed.data.application !== application) {
      throw new UnauthorizedException(
        'La sesion no corresponde a esta aplicacion.',
      );
    }
    return parsed.data;
  }

  async readFlow(token: string): Promise<OAuthFlow> {
    const parsed = flowSchema.safeParse(
      await this.verify(token, 'mapreko-oauth'),
    );
    if (!parsed.success)
      throw new UnauthorizedException('El inicio de acceso ha expirado.');
    return parsed.data;
  }
}
