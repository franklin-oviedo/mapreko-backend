import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { AuthSettings } from './auth.settings.js';
import type { GoogleProfile } from './auth.types.js';

const claimsSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.email(),
  email_verified: z.literal(true),
  iss: z.enum(['accounts.google.com', 'https://accounts.google.com']),
  nonce: z.string().min(1),
  exp: z
    .number()
    .int()
    .refine((value) => value > Math.floor(Date.now() / 1000)),
  given_name: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  family_name: z.string().trim().min(1).max(80).optional(),
  picture: z
    .url()
    .refine((value) => new URL(value).protocol === 'https:')
    .optional(),
});

@Injectable()
export class GoogleIdentityService {
  constructor(private readonly settings: AuthSettings) {}

  private client(): OAuth2Client {
    return new OAuth2Client({
      clientId: this.settings.require('GOOGLE_CLIENT_ID'),
      clientSecret: this.settings.require('GOOGLE_CLIENT_SECRET'),
      redirectUri: this.settings.require('GOOGLE_REDIRECT_URI'),
    });
  }

  authorizationUrl(state: string, nonce: string, challenge: string): string {
    return this.client().generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: CodeChallengeMethod.S256,
      prompt: 'select_account',
    });
  }

  async exchange(
    code: string,
    verifier: string,
    nonce: string,
  ): Promise<GoogleProfile> {
    const client = this.client();
    let idToken: string | null | undefined;
    try {
      const { tokens } = await client.getToken({
        code,
        codeVerifier: verifier,
      });
      idToken = tokens.id_token;
    } catch (error) {
      if (error instanceof Error && 'response' in error) {
        const response = error.response;
        if (
          typeof response === 'object' &&
          response !== null &&
          'status' in response &&
          typeof response.status === 'number' &&
          response.status >= 400 &&
          response.status < 500
        ) {
          throw new UnauthorizedException('El codigo de Google no es valido.');
        }
      }
      if (
        error instanceof Error &&
        ['GaxiosError', 'FetchError'].includes(error.name)
      ) {
        throw new ServiceUnavailableException(
          'No se pudo contactar con Google.',
        );
      }
      throw error;
    }
    if (!idToken)
      throw new UnauthorizedException('Google no devolvio una identidad.');

    let payload: unknown;
    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: this.settings.require('GOOGLE_CLIENT_ID'),
      });
      payload = ticket.getPayload();
    } catch (error) {
      // Google embeds the raw token in these validation errors.
      if (
        error instanceof Error &&
        /^(Wrong number|Can't parse token|No pem found|Invalid token signature|No issue time|No expiration time|iat field|exp field|Expiration time|Token used|Invalid issuer|Wrong recipient)/.test(
          error.message,
        )
      ) {
        throw new UnauthorizedException(
          'La identidad de Google no es valida o ha expirado.',
        );
      }
      if (
        error instanceof Error &&
        ['GaxiosError', 'FetchError'].includes(error.name)
      ) {
        throw new ServiceUnavailableException(
          'No se pudieron consultar los certificados de Google.',
        );
      }
      throw error;
    }
    const parsed = claimsSchema.safeParse(payload);
    if (!parsed.success || parsed.data.nonce !== nonce) {
      throw new UnauthorizedException(
        'La identidad de Google no esta verificada.',
      );
    }
    return {
      subject: parsed.data.sub,
      email: parsed.data.email.toLowerCase(),
      givenName: parsed.data.given_name ?? parsed.data.name ?? null,
      familyName: parsed.data.family_name ?? null,
      avatarUrl: parsed.data.picture ?? null,
    };
  }
}
