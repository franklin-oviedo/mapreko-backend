import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { parseSetCookie, stringifyCookie } from 'cookie';
import request from 'supertest';
import type { Response } from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthSettings } from '../src/auth/auth.settings.js';
import { GoogleIdentityService } from '../src/auth/google-identity.service.js';
import type { GoogleProfile, IssuedSession } from '../src/auth/auth.types.js';
import { configureHttp } from '../src/configure-http.js';
import { createTestDatabase } from './database-harness.js';

function responseCookies(response: Response): string[] {
  const header: unknown = response.headers['set-cookie'];
  if (typeof header === 'string') return [header];
  if (Array.isArray(header))
    return header.filter(
      (value: unknown): value is string => typeof value === 'string',
    );
  return [];
}

function cookieHeader(issued: IssuedSession): string {
  return stringifyCookie({
    [`mapreko_${issued.session.application}_access`]: issued.accessToken,
    [`mapreko_${issued.session.application}_refresh`]: issued.refreshToken,
  });
}

describe('Identity HTTP + PostgreSQL', () => {
  let app: INestApplication;
  let harness: Awaited<ReturnType<typeof createTestDatabase>>;
  let auth: AuthService;
  let google: GoogleIdentityService;
  let exchange: ReturnType<typeof vi.spyOn<GoogleIdentityService, 'exchange'>>;
  const origin = 'http://localhost:4200';
  const config = new ConfigService({
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: randomBytes(32).toString('hex'),
    GOOGLE_REDIRECT_URI: `${origin}/api/auth/google/callback`,
    FRONTEND_ORIGIN: origin,
    AUTH_SECRET: randomBytes(48).toString('hex'),
  });
  const freshProfile = (): GoogleProfile => ({
    subject: randomUUID(),
    email: `${randomUUID()}@example.test`,
    givenName: 'Ana',
    familyName: null,
    avatarUrl: null,
  });

  beforeAll(async () => {
    harness = await createTestDatabase();
    google = new GoogleIdentityService(new AuthSettings(config));
    exchange = vi.spyOn(google, 'exchange');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(harness.database)
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(GoogleIdentityService)
      .useValue(google)
      .compile();
    app = module.createNestApplication();
    configureHttp(app);
    await app.init();
    auth = app.get(AuthService);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.close();
  });

  afterEach(() => exchange.mockReset());

  async function start(application = 'user') {
    const response = await request(app.getHttpServer())
      .get(`/api/auth/google/start/${application}`)
      .expect(302);
    const location = new URL(String(response.headers.location));
    const flow = responseCookies(response)
      .map((value) => parseSetCookie(value))
      .find((cookie) => cookie.name === 'mapreko_oauth_flow');
    if (!flow?.value) throw new Error('Missing flow cookie');
    return {
      location,
      cookie: stringifyCookie({ [flow.name]: flow.value }),
      flow,
    };
  }

  it('uses minimal Google scopes, PKCE/state/nonce and HttpOnly cookies', async () => {
    const { location, flow } = await start();
    expect(location.origin).toBe('https://accounts.google.com');
    expect(location.searchParams.get('scope')?.split(' ')).toEqual([
      'openid',
      'email',
      'profile',
    ]);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    for (const key of ['state', 'nonce', 'code_challenge'])
      expect(location.searchParams.get(key)?.length).toBeGreaterThan(32);
    expect(location.searchParams.get('redirect_uri')).toBe(
      `${origin}/api/auth/google/callback`,
    );
    expect(flow).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: 600,
    });
  });

  it('registers on callback and restores only the authorized account without exposing credentials', async () => {
    const flow = await start();
    exchange.mockResolvedValueOnce(freshProfile());
    const response = await request(app.getHttpServer())
      .get('/api/auth/google/callback')
      .query({
        state: flow.location.searchParams.get('state'),
        code: 'valid-code',
      })
      .set('Cookie', flow.cookie)
      .expect(302);
    expect(response.headers.location).toBe(`${origin}/app`);
    expect(exchange).toHaveBeenCalledWith(
      'valid-code',
      expect.any(String),
      flow.location.searchParams.get('nonce'),
    );
    const cookies = responseCookies(response)
      .map((value) => parseSetCookie(value))
      .filter((cookie) => cookie.value);
    expect(cookies).toHaveLength(2);
    expect(
      cookies.every((cookie) => cookie.httpOnly && cookie.sameSite === 'lax'),
    ).toBe(true);
    const header = stringifyCookie(
      Object.fromEntries(cookies.map((cookie) => [cookie.name, cookie.value])),
    );
    const session = await request(app.getHttpServer())
      .get('/api/auth/user/session')
      .set('Cookie', header)
      .expect(200);
    expect(session.headers['cache-control']).toBe('no-store');
    expect(session.body).toMatchObject({
      application: 'user',
      roles: ['user'],
      user: { emailVerified: true },
      workspaces: [{ kind: 'personal', role: 'owner' }],
    });
    expect(JSON.stringify(session.body)).not.toMatch(
      /accessToken|refreshToken|subject|token_hash/,
    );
    await request(app.getHttpServer())
      .get('/api/auth/admin/session')
      .set('Cookie', header)
      .expect(401);
  });

  it('handles cancellation and rejects forged or missing state without contacting Google', async () => {
    const flow = await start();
    const cancelled = await request(app.getHttpServer())
      .get('/api/auth/google/callback')
      .query({
        state: flow.location.searchParams.get('state'),
        error: 'access_denied',
      })
      .set('Cookie', flow.cookie)
      .expect(302);
    expect(cancelled.headers.location).toBe(`${origin}/login?error=cancelled`);
    await request(app.getHttpServer())
      .get('/api/auth/google/callback')
      .query({ state: 'x'.repeat(43), code: 'code' })
      .set('Cookie', flow.cookie)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/auth/google/callback')
      .query({ state: 'ñ'.repeat(43), code: 'code' })
      .set('Cookie', flow.cookie)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/auth/google/callback')
      .query({ code: 'code' })
      .expect(401);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('returns a controlled failure for invalid Google identity', async () => {
    const flow = await start();
    exchange.mockRejectedValueOnce(
      new UnauthorizedException('Invalid provider token'),
    );
    const response = await request(app.getHttpServer())
      .get('/api/auth/google/callback')
      .query({
        state: flow.location.searchParams.get('state'),
        code: 'expired-code',
      })
      .set('Cookie', flow.cookie)
      .expect(302);
    expect(response.headers.location).toBe(
      `${origin}/login?error=invalid_identity`,
    );
    expect(
      responseCookies(response).some((value) =>
        value.startsWith('mapreko_user_access='),
      ),
    ).toBe(false);
  });

  it('registers concurrent first logins as one user, one Google identity and one personal workspace', async () => {
    const profile = freshProfile();
    const [first, second] = await Promise.all([
      auth.signIn(profile, 'user'),
      auth.signIn(profile, 'user'),
    ]);
    expect(first.session.user.id).toBe(second.session.user.id);
    const [counts] = await harness.database.query<
      { identities: string; spaces: string }[]
    >(
      `
      SELECT (SELECT count(*) FROM auth_identities WHERE subject = $1) AS identities,
        (SELECT count(*) FROM workspaces WHERE owner_user_id = $2 AND kind = 'personal') AS spaces
    `,
      [profile.subject, first.session.user.id],
    );
    expect(counts).toEqual({ identities: '1', spaces: '1' });
    await expect(
      auth.signIn({ ...profile, subject: randomUUID() }, 'user'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('accepts unavailable Google names and keeps the editable profile separate from later synchronizations', async () => {
    const profile = { ...freshProfile(), givenName: null };
    const first = await auth.signIn(profile, 'user');
    expect(first.session.user.givenName).toBeNull();
    await request(app.getHttpServer())
      .patch('/api/auth/user/profile')
      .set('Cookie', cookieHeader(first))
      .set('Origin', origin)
      .set('X-Mapreko-Request', '1')
      .send({
        givenName: 'Nombre local',
        phone: '+1 809 555 0100',
        timeZone: 'America/Santo_Domingo',
      })
      .expect(200);
    const next = await auth.signIn(
      { ...profile, givenName: 'Nombre Google' },
      'user',
    );
    expect(next.session.user.givenName).toBe('Nombre local');
    const [identity] = await harness.database.query<
      { subject: string; given_name: string }[]
    >('SELECT subject, given_name FROM auth_identities WHERE user_id = $1', [
      first.session.user.id,
    ]);
    expect(identity).toEqual({
      subject: profile.subject,
      given_name: 'Nombre Google',
    });
  });

  it('blocks CSRF, invalid profile values and attempts to edit Google identity', async () => {
    const issued = await auth.signIn(freshProfile(), 'user');
    const patch = () =>
      request(app.getHttpServer())
        .patch('/api/auth/user/profile')
        .set('Cookie', cookieHeader(issued));
    await patch().send({ phone: '+18095550100' }).expect(403);
    await patch()
      .set('Origin', 'https://attacker.example')
      .set('X-Mapreko-Request', '1')
      .send({ phone: '+18095550100' })
      .expect(403);
    for (const body of [
      { subject: 'modified' },
      { email: 'changed@example.test' },
      { phone: 'bad' },
      { phone: '-------' },
      { phone: '1234567890123456' },
      { timeZone: 'Invalid/Zone' },
      {},
    ]) {
      await patch()
        .set('Origin', origin)
        .set('X-Mapreko-Request', '1')
        .send(body)
        .expect(400);
    }
  });

  it('rotates tokens and commits family revocation when an already consumed token is reused', async () => {
    const issued = await auth.signIn(freshProfile(), 'user');
    const first = await auth.refresh(issued.refreshToken, 'user');
    expect(first.refreshToken).not.toBe(issued.refreshToken);
    await expect(
      auth.refresh(issued.refreshToken, 'user'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      auth.authenticate(first.accessToken, 'user'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      auth.refresh(first.refreshToken, 'user'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const [event] = await harness.database.query<{ count: string }[]>(
      `SELECT count(*) FROM auth_events WHERE user_id = $1 AND event_type = 'refresh_reuse_detected'`,
      [issued.session.user.id],
    );
    expect(Number(event.count)).toBeGreaterThan(0);
  });

  it('serializes competing refresh requests without leaving a live token after detected reuse', async () => {
    const issued = await auth.signIn(freshProfile(), 'user');
    const results = await Promise.allSettled([
      auth.refresh(issued.refreshToken, 'user'),
      auth.refresh(issued.refreshToken, 'user'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { status: 401 } });
    await expect(
      auth.authenticate(issued.accessToken, 'user'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('revokes tokens created after a waiting revocation transaction began', async () => {
    const issued = await auth.signIn(freshProfile(), 'user');
    const blocker = harness.database.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    await blocker.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [
      issued.session.id,
    ]);
    const revocation = Promise.allSettled([
      auth.revokeSession(issued.session, issued.session.id),
    ]);
    try {
      await vi.waitFor(
        async () => {
          const [waiting] = await harness.database.query<
            { blocked: boolean }[]
          >(
            `
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE application_name = $1
              AND wait_event_type = 'Lock' AND query LIKE '%FROM sessions WHERE id =%FOR UPDATE%'
          ) AS blocked
        `,
            [harness.schema],
          );
          expect(waiting.blocked).toBe(true);
        },
        { timeout: 3000, interval: 10 },
      );
      await blocker.query(
        `
        INSERT INTO session_refresh_tokens (session_id, token_hash, expires_at, created_at)
        VALUES ($1, $2, $3, clock_timestamp())
      `,
        [
          issued.session.id,
          randomBytes(32).toString('hex'),
          issued.session.expiresAt,
        ],
      );
      await blocker.commitTransaction();
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await blocker.release();
    }
    expect(await revocation).toEqual([
      { status: 'fulfilled', value: undefined },
    ]);
    await expect(
      auth.authenticate(issued.accessToken, 'user'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('closes sessions idempotently and rejects both old access and refresh credentials', async () => {
    const issued = await auth.signIn(freshProfile(), 'user');
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(app.getHttpServer())
        .post('/api/auth/user/logout')
        .set('Cookie', cookieHeader(issued))
        .set('Origin', origin)
        .set('X-Mapreko-Request', '1')
        .send({})
        .expect(204);
      expect(
        responseCookies(response).every((cookie) =>
          cookie.includes('Max-Age=0'),
        ),
      ).toBe(true);
    }
    await request(app.getHttpServer())
      .get('/api/auth/user/session')
      .set('Cookie', cookieHeader(issued))
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/auth/user/refresh')
      .set('Cookie', cookieHeader(issued))
      .set('Origin', origin)
      .set('X-Mapreko-Request', '1')
      .send({})
      .expect(401);
  });

  it('also revokes the server session when logout only carries a valid access cookie', async () => {
    const issued = await auth.signIn(freshProfile(), 'user');
    await request(app.getHttpServer())
      .post('/api/auth/user/logout')
      .set(
        'Cookie',
        stringifyCookie({ mapreko_user_access: issued.accessToken }),
      )
      .set('Origin', origin)
      .set('X-Mapreko-Request', '1')
      .send({})
      .expect(204);
    await expect(
      auth.authenticate(issued.accessToken, 'user'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      auth.refresh(issued.refreshToken, 'user'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('separates User/Admin, requires explicit grants and rechecks suspension and revoked admin access', async () => {
    const profile = freshProfile();
    await expect(auth.signIn(profile, 'admin')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const user = await auth.signIn(profile, 'user');
    await expect(auth.signIn(profile, 'admin')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await harness.database.query(
      `INSERT INTO platform_admins (user_id, role, granted_by) VALUES ($1, 'support', $1)`,
      [user.session.user.id],
    );
    const admin = await auth.signIn(profile, 'admin');
    expect(admin.session.permissions).toContain('admin:access');
    expect(admin.session.permissions).not.toContain('knowledge:write');
    await expect(
      auth.authenticate(user.accessToken, 'admin'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await auth.logout(admin.refreshToken, 'admin');
    expect((await auth.authenticate(user.accessToken, 'user')).id).toBe(
      user.session.id,
    );
    const nextAdmin = await auth.signIn(profile, 'admin');
    await harness.database.query(
      'UPDATE platform_admins SET revoked_at = now() WHERE user_id = $1',
      [user.session.user.id],
    );
    await expect(
      auth.authenticate(nextAdmin.accessToken, 'admin'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      auth.refresh(nextAdmin.refreshToken, 'admin'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await harness.database.query(
      `UPDATE users SET status = 'suspended' WHERE id = $1`,
      [user.session.user.id],
    );
    await expect(auth.signIn(profile, 'user')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      auth.authenticate(user.accessToken, 'user'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects expired/tampered credentials and prevents revoking another user session', async () => {
    const issued = await auth.signIn(freshProfile(), 'user');
    const other = await auth.signIn(freshProfile(), 'user');
    await expect(
      auth.authenticate(`${issued.accessToken}tampered`, 'user'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      auth.revokeSession(issued.session, other.session.id),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const sessions = await auth.listSessions(issued.session);
    expect(sessions.map((session) => session.id)).toEqual([issued.session.id]);
    await auth.revokeSession(issued.session, issued.session.id);
    await expect(
      auth.authenticate(issued.accessToken, 'user'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await harness.database.query(
      `UPDATE sessions SET expires_at = created_at + interval '1 millisecond', created_at = now() - interval '1 day' WHERE id = $1`,
      [other.session.id],
    );
    await expect(
      auth.authenticate(other.accessToken, 'user'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      auth.refresh(other.refreshToken, 'user'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('documents identity endpoints in OpenAPI', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    const paths: Record<string, unknown> = response.body.paths;
    expect(paths).toHaveProperty('/api/auth/{application}/profile');
    expect(paths).toHaveProperty('/api/auth/{application}/refresh');
    expect(paths).toHaveProperty('/api/auth/google/callback');
  });
});
