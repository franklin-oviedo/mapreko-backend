import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';

export function configureHttp(app: INestApplication): void {
  app.use(
    '/api/auth',
    (_request: Request, response: Response, next: NextFunction) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Pragma', 'no-cache');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      next();
    },
  );
  const config = new DocumentBuilder()
    .setTitle('MAPREKO API')
    .setDescription(
      'Identidad Google, perfiles y sesiones independientes de User / Admin.',
    )
    .setVersion('1.0')
    .addCookieAuth(
      'mapreko_user_access',
      { type: 'apiKey', in: 'cookie' },
      'mapreko-session',
    )
    .addCookieAuth(
      'mapreko_admin_access',
      { type: 'apiKey', in: 'cookie' },
      'mapreko-admin-session',
    )
    .build();
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(app, config),
  );
}
