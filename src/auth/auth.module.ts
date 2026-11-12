import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthSettings } from './auth.settings.js';
import { AuthTokens } from './auth-tokens.service.js';
import { GoogleIdentityService } from './google-identity.service.js';
import { SameOriginGuard, SessionGuard } from './auth.guard.js';

@Module({
  imports: [
    JwtModule.register({}),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 120 }]),
  ],
  controllers: [AuthController],
  providers: [
    AuthSettings,
    AuthTokens,
    AuthService,
    GoogleIdentityService,
    SameOriginGuard,
    SessionGuard,
  ],
  exports: [AuthService, AuthSettings, SessionGuard, SameOriginGuard],
})
export class AuthModule {}
