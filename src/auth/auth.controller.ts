import { timingSafeEqual, createHash } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { parseCookie, stringifySetCookie } from 'cookie';
import type { Request, Response } from 'express';
import { AuthTokens, randomToken } from './auth-tokens.service.js';
import { CurrentSession, SameOriginGuard, SessionGuard } from './auth.guard.js';
import { AuthSettings } from './auth.settings.js';
import { AuthService } from './auth.service.js';
import { GoogleIdentityService } from './google-identity.service.js';
import { parseApplication, phonePattern, profileSchema } from './auth.types.js';
import type { Application, AuthSession, IssuedSession } from './auth.types.js';

@ApiTags('Identity & Access')
@Controller('api/auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(
    private readonly settings: AuthSettings,
    private readonly tokens: AuthTokens,
    private readonly google: GoogleIdentityService,
    private readonly auth: AuthService,
  ) {}

  @Get('config')
  @ApiOperation({
    summary: 'Estado publico de configuracion; nunca devuelve credenciales',
  })
  configuration() {
    return { googleConfigured: this.settings.ready };
  }

  @Get('google/start/:application')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Iniciar Google OIDC con state, nonce y PKCE' })
  @ApiParam({ name: 'application', enum: ['user', 'admin'] })
  @ApiResponse({
    status: 302,
    description: 'Redireccion a Google; cookie de flujo HttpOnly de 10 minutos',
  })
  async start(@Param('application') value: string, @Res() response: Response) {
    if (!this.settings.ready) {
      throw new ServiceUnavailableException(
        'El acceso con Google aun no esta configurado.',
      );
    }
    const application = parseApplication(value);
    const flow = {
      application,
      state: randomToken(),
      nonce: randomToken(),
      verifier: randomToken(),
    };
    const signed = await this.tokens.flow(flow);
    const challenge = createHash('sha256')
      .update(flow.verifier)
      .digest('base64url');
    const url = this.google.authorizationUrl(flow.state, flow.nonce, challenge);
    response.appendHeader(
      'Set-Cookie',
      stringifySetCookie({
        name: this.settings.cookie('flow'),
        value: signed,
        ...this.settings.cookieOptions('flow'),
        maxAge: 600,
      }),
    );
    response.redirect(url);
  }

  @Get('google/callback')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: 'Validar respuesta Google y emitir sesion propia de MAPREKO',
  })
  @ApiResponse({
    status: 302,
    description:
      'Redireccion al perfil o a login con codigo de error no sensible',
  })
  async callback(
    @Query('state') state: unknown,
    @Query('code') code: unknown,
    @Query('error') providerError: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const cookie = parseCookie(request.headers.cookie ?? '')[
      this.settings.cookie('flow')
    ];
    this.clearFlow(response);
    if (!cookie)
      throw new UnauthorizedException('El inicio de acceso ha expirado.');
    const flow = await this.tokens.readFlow(cookie);
    if (
      typeof state !== 'string' ||
      Buffer.byteLength(state) !== Buffer.byteLength(flow.state) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(flow.state))
    ) {
      await this.auth.recordFailure(flow.application, 'invalid_state');
      throw new UnauthorizedException(
        'No se pudo validar el inicio de acceso.',
      );
    }
    const login = flow.application === 'admin' ? '/admin/login' : '/login';
    if (providerError !== undefined) {
      await this.auth.recordFailure(flow.application, 'google_cancelled');
      return response.redirect(
        `${this.settings.origin}${login}?error=cancelled`,
      );
    }
    if (typeof code !== 'string' || code.length === 0 || code.length > 4096) {
      throw new BadRequestException(
        'La respuesta de Google no contiene un codigo valido.',
      );
    }
    try {
      const profile = await this.google.exchange(
        code,
        flow.verifier,
        flow.nonce,
      );
      const issued = await this.auth.signIn(profile, flow.application);
      this.writeSession(response, issued);
      return response.redirect(
        `${this.settings.origin}${flow.application === 'admin' ? '/admin' : '/app'}`,
      );
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      const status = error.getStatus();
      const reason =
        error instanceof ForbiddenException
          ? 'access_denied'
          : status === 409
            ? 'account_conflict'
            : status >= 500
              ? 'provider_unavailable'
              : 'invalid_identity';
      await this.auth.recordFailure(flow.application, reason);
      return response.redirect(
        `${this.settings.origin}${login}?error=${reason}`,
      );
    }
  }

  @Get(':application/session')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('mapreko-session')
  @ApiCookieAuth('mapreko-admin-session')
  @ApiParam({ name: 'application', enum: ['user', 'admin'] })
  @ApiOperation({
    summary: 'Consultar perfil, permisos actuales y espacios de la sesion',
  })
  @ApiResponse({
    status: 200,
    description:
      'Sesion vigente: id, application, expiresAt, user, roles, permissions, workspaces',
  })
  @ApiResponse({
    status: 401,
    description: 'Sesion ausente, expirada o revocada',
  })
  session(@CurrentSession() session: AuthSession) {
    return session;
  }

  @Post(':application/refresh')
  @HttpCode(200)
  @UseGuards(SameOriginGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: 'Rotar refresh token; su reutilizacion revoca toda la sesion',
  })
  @ApiHeader({
    name: 'X-Mapreko-Request',
    required: true,
    description: 'Valor 1; tambien requiere Origin autorizado',
  })
  @ApiResponse({
    status: 200,
    description: 'Sesion renovada, con nuevas cookies HttpOnly',
  })
  async refresh(
    @Param('application') value: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const application = parseApplication(value);
    const token = parseCookie(request.headers.cookie ?? '')[
      this.settings.cookie('refresh', application)
    ];
    if (!token) throw new UnauthorizedException('Inicia sesion nuevamente.');
    try {
      const issued = await this.auth.refresh(token, application);
      this.writeSession(response, issued);
      return issued.session;
    } catch (error) {
      if (error instanceof UnauthorizedException)
        this.clearSession(response, application);
      throw error;
    }
  }

  @Post(':application/logout')
  @HttpCode(204)
  @UseGuards(SameOriginGuard)
  @ApiOperation({
    summary: 'Cerrar e invalidar la sesion; operacion idempotente',
  })
  @ApiHeader({ name: 'X-Mapreko-Request', required: true })
  async logout(
    @Param('application') value: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const application = parseApplication(value);
    const cookies = parseCookie(request.headers.cookie ?? '');
    const token = cookies[this.settings.cookie('refresh', application)];
    await this.auth.logout(
      token,
      application,
      cookies[this.settings.cookie('access', application)],
    );
    this.clearSession(response, application);
  }

  @Patch(':application/profile')
  @UseGuards(SameOriginGuard, SessionGuard)
  @ApiCookieAuth('mapreko-session')
  @ApiCookieAuth('mapreko-admin-session')
  @ApiHeader({ name: 'X-Mapreko-Request', required: true })
  @ApiOperation({
    summary:
      'Actualizar solo campos propios; Google subject/email no son editables',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        givenName: { type: 'string', maxLength: 80, nullable: true },
        familyName: { type: 'string', maxLength: 80, nullable: true },
        displayName: { type: 'string', maxLength: 120, nullable: true },
        phone: {
          type: 'string',
          nullable: true,
          pattern: phonePattern.source,
        },
        locale: { type: 'string', enum: ['es', 'en'] },
        timeZone: { type: 'string', description: 'Zona horaria IANA' },
      },
    },
  })
  updateProfile(@CurrentSession() session: AuthSession, @Body() body: unknown) {
    const parsed = profileSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        message: 'Revisa los datos del perfil.',
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
    return this.auth.updateProfile(session, parsed.data);
  }

  @Get(':application/sessions')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('mapreko-session')
  @ApiCookieAuth('mapreko-admin-session')
  @ApiOperation({
    summary: 'Listar sesiones propias activas de esta aplicacion',
  })
  listSessions(@CurrentSession() session: AuthSession) {
    return this.auth.listSessions(session);
  }

  @Delete(':application/sessions/:id')
  @HttpCode(204)
  @UseGuards(SameOriginGuard, SessionGuard)
  @ApiCookieAuth('mapreko-session')
  @ApiCookieAuth('mapreko-admin-session')
  @ApiHeader({ name: 'X-Mapreko-Request', required: true })
  @ApiOperation({
    summary: 'Revocar una sesion propia sin afectar la otra aplicacion',
  })
  async revoke(
    @CurrentSession() session: AuthSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.revokeSession(session, id);
    if (session.id === id) this.clearSession(response, session.application);
  }

  private writeSession(response: Response, issued: IssuedSession): void {
    for (const kind of ['access', 'refresh'] as const) {
      response.appendHeader(
        'Set-Cookie',
        stringifySetCookie({
          name: this.settings.cookie(kind, issued.session.application),
          value: kind === 'access' ? issued.accessToken : issued.refreshToken,
          ...this.settings.cookieOptions(kind),
          ...(kind === 'access'
            ? { maxAge: 900 }
            : { expires: issued.session.expiresAt }),
        }),
      );
    }
  }

  private clearSession(response: Response, application: Application): void {
    for (const kind of ['access', 'refresh'] as const) {
      response.appendHeader(
        'Set-Cookie',
        stringifySetCookie({
          name: this.settings.cookie(kind, application),
          value: '',
          ...this.settings.cookieOptions(kind),
          maxAge: 0,
        }),
      );
    }
  }

  private clearFlow(response: Response): void {
    response.appendHeader(
      'Set-Cookie',
      stringifySetCookie({
        name: this.settings.cookie('flow'),
        value: '',
        ...this.settings.cookieOptions('flow'),
        maxAge: 0,
      }),
    );
  }
}
