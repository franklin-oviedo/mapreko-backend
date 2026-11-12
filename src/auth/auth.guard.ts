import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { parseCookie } from 'cookie';
import type { Request } from 'express';
import { AuthSettings } from './auth.settings.js';
import { AuthService } from './auth.service.js';
import { parseApplication } from './auth.types.js';
import type { AuthSession } from './auth.types.js';

interface AuthenticatedRequest extends Request {
  auth?: AuthSession;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly settings: AuthSettings,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const application = parseApplication(request.params.application);
    const token = parseCookie(request.headers.cookie ?? '')[
      this.settings.cookie('access', application)
    ];
    if (!token)
      throw new UnauthorizedException('Inicia sesion para continuar.');
    request.auth = await this.auth.authenticate(token, application);
    return true;
  }
}

@Injectable()
export class SameOriginGuard implements CanActivate {
  constructor(private readonly settings: AuthSettings) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    // Custom header forces preflight; CORS is not enabled. Exact Origin also
    // protects against same-site sibling origins and requests with null origin.
    if (
      request.headers.origin !== this.settings.origin ||
      request.headers['x-mapreko-request'] !== '1' ||
      request.headers['sec-fetch-site'] === 'cross-site'
    ) {
      throw new ForbiddenException('Origen de solicitud no permitido.');
    }
    return true;
  }
}

export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthSession => {
    const session = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>().auth;
    if (!session)
      throw new UnauthorizedException('Inicia sesion para continuar.');
    return session;
  },
);
