import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SerializeOptions } from 'cookie';
import type { Application } from './auth.types.js';

@Injectable()
export class AuthSettings {
  constructor(private readonly config: ConfigService) {}

  get ready(): boolean {
    const origin = this.config.get<string>('FRONTEND_ORIGIN') ?? '';
    const redirect = this.config.get<string>('GOOGLE_REDIRECT_URI') ?? '';
    return (
      [
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'AUTH_SECRET',
        'FRONTEND_ORIGIN',
        'GOOGLE_REDIRECT_URI',
      ].every((key) => Boolean(this.config.get<string>(key)?.trim())) &&
      Buffer.byteLength(this.config.get<string>('AUTH_SECRET') ?? '') >= 32 &&
      URL.canParse(origin) &&
      new URL(origin).origin === origin &&
      ['https:', 'http:'].includes(new URL(origin).protocol) &&
      (this.config.get('NODE_ENV') !== 'production' ||
        origin.startsWith('https://')) &&
      redirect === `${origin}/api/auth/google/callback`
    );
  }

  require(key: string): string {
    const value = this.config.get<string>(key)?.trim();
    if (!value) {
      throw new ServiceUnavailableException(
        'El acceso con Google aun no esta configurado.',
      );
    }
    return value;
  }

  get secret(): string {
    const value = this.require('AUTH_SECRET');
    if (Buffer.byteLength(value) < 32) {
      throw new ServiceUnavailableException(
        'AUTH_SECRET requiere al menos 32 bytes aleatorios.',
      );
    }
    return value;
  }

  get origin(): string {
    const value = this.require('FRONTEND_ORIGIN');
    if (!URL.canParse(value)) {
      throw new ServiceUnavailableException(
        'FRONTEND_ORIGIN no es un origen HTTP valido.',
      );
    }
    const url = new URL(value);
    if (url.origin !== value || !['https:', 'http:'].includes(url.protocol)) {
      throw new ServiceUnavailableException(
        'FRONTEND_ORIGIN debe ser un origen HTTP sin ruta.',
      );
    }
    if (
      this.config.get('NODE_ENV') === 'production' &&
      url.protocol !== 'https:'
    ) {
      throw new ServiceUnavailableException(
        'El entorno de produccion requiere HTTPS.',
      );
    }
    return value;
  }

  get secure(): boolean {
    return new URL(this.origin).protocol === 'https:';
  }

  cookie(
    kind: 'access' | 'refresh' | 'flow',
    application: Application = 'user',
  ): string {
    return kind === 'flow'
      ? 'mapreko_oauth_flow'
      : `mapreko_${application}_${kind}`;
  }

  cookieOptions(kind: 'access' | 'refresh' | 'flow'): SerializeOptions {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: kind === 'access' ? '/api' : '/api/auth',
    };
  }
}
