import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthTokens, randomToken, tokenHash } from './auth-tokens.service.js';
import { userColumns } from './auth.types.js';
import type {
  Application,
  AuthSession,
  GoogleProfile,
  IssuedSession,
  ProfileUpdate,
  UserProfile,
  WorkspaceAccess,
} from './auth.types.js';

interface SessionRow extends UserProfile {
  sessionId: string;
  expiresAt: Date;
  status: string;
  adminRole: 'admin' | 'support' | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly database: DataSource,
    private readonly tokens: AuthTokens,
  ) {}

  private async context(
    manager: EntityManager,
    sessionId: string,
    application: Application,
    userId?: string,
  ): Promise<AuthSession> {
    const [row] = await manager.query<SessionRow[]>(
      `
      SELECT ${userColumns}, s.id AS "sessionId", s.expires_at AS "expiresAt",
        u.status, a.role AS "adminRole"
      FROM sessions s JOIN users u ON u.id = s.user_id
      LEFT JOIN platform_admins a ON a.user_id = u.id AND a.revoked_at IS NULL
      WHERE s.id = $1 AND s.application = $2
        AND ($3::uuid IS NULL OR s.user_id = $3)
        AND s.revoked_at IS NULL AND s.ended_at IS NULL AND s.expires_at > clock_timestamp()
    `,
      [sessionId, application, userId ?? null],
    );
    if (!row) throw new UnauthorizedException('La sesion no esta activa.');
    if (row.status !== 'active')
      throw new ForbiddenException('Tu cuenta esta suspendida o inactiva.');
    let roles = ['user'];
    if (application === 'admin') {
      if (!row.adminRole)
        throw new ForbiddenException('No tienes acceso a MAPREKO Admin.');
      roles = [row.adminRole];
    }
    const workspaces =
      application === 'user'
        ? await manager.query<WorkspaceAccess[]>(
            `
          SELECT w.id, w.name, w.kind,
            CASE WHEN w.owner_user_id = m.user_id THEN 'owner' ELSE m.role END AS role
          FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.user_id = $1 AND m.status = 'active' AND w.archived_at IS NULL
          ORDER BY w.created_at, w.id
        `,
            [row.id],
          )
        : [];
    const {
      sessionId: id,
      expiresAt,
      status: _status,
      adminRole,
      ...user
    } = row;
    return {
      id,
      application,
      expiresAt,
      user,
      roles,
      permissions: [
        'profile:read',
        'profile:update',
        'sessions:manage',
        ...(application === 'user'
          ? ['user:access']
          : ['admin:access', 'knowledge:read']),
        ...(application === 'admin' && adminRole === 'admin'
          ? ['knowledge:write']
          : []),
      ],
      workspaces,
    };
  }

  private async audit(
    manager: EntityManager,
    userId: string | null,
    application: Application,
    event: string,
    reason: string | null = null,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO auth_events (user_id, application, event_type, reason_code, occurred_at) VALUES ($1, $2, $3, $4, clock_timestamp())`,
      [userId, application, event, reason],
    );
  }

  async recordFailure(application: Application, reason: string): Promise<void> {
    await this.audit(
      this.database.manager,
      null,
      application,
      'sign_in_failed',
      reason,
    );
  }

  async signIn(
    profile: GoogleProfile,
    application: Application,
  ): Promise<IssuedSession> {
    const refreshToken = randomToken();
    const session = await this.database.transaction(async (manager) => {
      // Serializes registration by stable Google identity across all API instances.
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`google:${profile.subject}`],
      );
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 1))',
        [`email:${profile.email}`],
      );
      const [identity] = await manager.query<
        { userId: string; status: string }[]
      >(
        `
        SELECT u.id AS "userId", u.status FROM auth_identities i JOIN users u ON u.id = i.user_id
        WHERE i.provider = 'google' AND i.subject = $1 FOR UPDATE OF u
      `,
        [profile.subject],
      );
      if (identity && identity.status !== 'active') {
        throw new ForbiddenException('Tu cuenta esta suspendida o inactiva.');
      }
      if (application === 'admin') {
        const admins = identity
          ? await manager.query<{ userId: string }[]>(
              'SELECT user_id AS "userId" FROM platform_admins WHERE user_id = $1 AND revoked_at IS NULL',
              [identity.userId],
            )
          : [];
        if (admins.length === 0)
          throw new ForbiddenException('No tienes acceso a MAPREKO Admin.');
      }
      const conflicts = await manager.query<{ id: string }[]>(
        'SELECT id FROM users WHERE lower(btrim(email)) = lower(btrim($1)) AND ($2::uuid IS NULL OR id <> $2)',
        [profile.email, identity?.userId ?? null],
      );
      if (conflicts.length > 0) {
        throw new ConflictException(
          'Este correo ya pertenece a otra cuenta. Contacta con soporte para conservar tus datos.',
        );
      }

      let userId = identity?.userId;
      if (!userId) {
        const [user] = await manager.query<{ id: string }[]>(
          `
          INSERT INTO users (email, email_verified, given_name, family_name, avatar_url, last_login_at)
          VALUES ($1, true, $2, $3, $4, now()) RETURNING id
        `,
          [
            profile.email,
            profile.givenName,
            profile.familyName,
            profile.avatarUrl,
          ],
        );
        userId = user.id;
        await manager.query(
          `
          INSERT INTO auth_identities (user_id, subject, email, email_verified, given_name, family_name, avatar_url)
          VALUES ($1, $2, $3, true, $4, $5, $6)
        `,
          [
            userId,
            profile.subject,
            profile.email,
            profile.givenName,
            profile.familyName,
            profile.avatarUrl,
          ],
        );
        const [workspace] = await manager.query<{ id: string }[]>(
          `INSERT INTO workspaces (kind, name, owner_user_id) VALUES ('personal', 'Mi hogar', $1) RETURNING id`,
          [userId],
        );
        await manager.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
          [workspace.id, userId],
        );
      } else {
        await manager.query(
          `
          UPDATE auth_identities SET email = $2, email_verified = true, given_name = $3,
            family_name = $4, avatar_url = $5, synced_at = now()
          WHERE user_id = $1 AND provider = 'google'
        `,
          [
            userId,
            profile.email,
            profile.givenName,
            profile.familyName,
            profile.avatarUrl,
          ],
        );
        await manager.query(
          `
          UPDATE users SET email = $2, email_verified = true, avatar_url = $3, last_login_at = now() WHERE id = $1
        `,
          [userId, profile.email, profile.avatarUrl],
        );
      }
      const [created] = await manager.query<{ id: string; expiresAt: Date }[]>(
        `
        INSERT INTO sessions (user_id, application, expires_at) VALUES ($1, $2, now() + interval '30 days')
        RETURNING id, expires_at AS "expiresAt"
      `,
        [userId, application],
      );
      await manager.query(
        `
        INSERT INTO session_refresh_tokens (session_id, token_hash, expires_at) VALUES ($1, $2, $3)
      `,
        [created.id, tokenHash(refreshToken), created.expiresAt],
      );
      await this.audit(manager, userId, application, 'sign_in');
      return this.context(manager, created.id, application, userId);
    });
    return {
      session,
      accessToken: await this.tokens.access(session),
      refreshToken,
    };
  }

  async authenticate(
    token: string,
    application: Application,
  ): Promise<AuthSession> {
    const claims = await this.tokens.readAccess(token, application);
    return this.context(
      this.database.manager,
      claims.sid,
      application,
      claims.sub,
    );
  }

  async refresh(
    rawToken: string,
    application: Application,
  ): Promise<IssuedSession> {
    const refreshToken = randomToken();
    const result = await this.database.transaction(async (manager) => {
      const [candidate] = await manager.query<{ id: string }[]>(
        `
        SELECT s.id FROM sessions s JOIN session_refresh_tokens t ON t.session_id = s.id
        WHERE t.token_hash = $1 AND s.application = $2
      `,
        [tokenHash(rawToken), application],
      );
      if (!candidate) return null;
      // Always lock the session before its token rows to avoid rotation/revocation deadlocks.
      await manager.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [
        candidate.id,
      ]);
      const [row] = await manager.query<
        {
          id: string;
          sessionId: string;
          userId: string;
          usedAt: Date | null;
          revokedAt: Date | null;
          sessionRevokedAt: Date | null;
          endedAt: Date | null;
          expiresAt: Date;
          tokenExpiresAt: Date;
          now: Date;
          status: string;
          adminRole: string | null;
        }[]
      >(
        `
        SELECT t.id, t.session_id AS "sessionId", s.user_id AS "userId", t.used_at AS "usedAt",
          t.revoked_at AS "revokedAt", s.revoked_at AS "sessionRevokedAt", s.ended_at AS "endedAt",
          s.expires_at AS "expiresAt", t.expires_at AS "tokenExpiresAt", clock_timestamp() AS now,
          u.status, a.role AS "adminRole"
        FROM session_refresh_tokens t JOIN sessions s ON s.id = t.session_id
        JOIN users u ON u.id = s.user_id
        LEFT JOIN platform_admins a ON a.user_id = u.id AND a.revoked_at IS NULL
        WHERE t.token_hash = $1 AND s.application = $2 FOR UPDATE OF s, t
      `,
        [tokenHash(rawToken), application],
      );
      if (!row) return null;
      if (row.usedAt) {
        await this.revoke(
          manager,
          row.sessionId,
          row.userId,
          application,
          'refresh_reuse_detected',
        );
        return null;
      }
      if (
        row.revokedAt ||
        row.sessionRevokedAt ||
        row.endedAt ||
        row.expiresAt <= row.now ||
        row.tokenExpiresAt <= row.now
      )
        return null;
      if (
        row.status !== 'active' ||
        (application === 'admin' && !row.adminRole)
      ) {
        await this.revoke(
          manager,
          row.sessionId,
          row.userId,
          application,
          'account_access_removed',
        );
        return null;
      }
      await manager.query(
        'UPDATE session_refresh_tokens SET used_at = clock_timestamp() WHERE id = $1',
        [row.id],
      );
      await manager.query(
        `
        INSERT INTO session_refresh_tokens (session_id, token_hash, rotated_from_id, expires_at)
        VALUES ($1, $2, $3, $4)
      `,
        [row.sessionId, tokenHash(refreshToken), row.id, row.expiresAt],
      );
      await manager.query(
        'UPDATE sessions SET last_seen_at = clock_timestamp() WHERE id = $1',
        [row.sessionId],
      );
      await this.audit(manager, row.userId, application, 'refresh_rotated');
      return this.context(manager, row.sessionId, application, row.userId);
    });
    // Reuse revocation must commit even though the HTTP operation is rejected.
    if (!result)
      throw new UnauthorizedException(
        'No se pudo renovar la sesion. Inicia sesion nuevamente.',
      );
    return {
      session: result,
      accessToken: await this.tokens.access(result),
      refreshToken,
    };
  }

  private async revoke(
    manager: EntityManager,
    sessionId: string,
    userId: string,
    application: Application,
    reason: string,
  ): Promise<void> {
    await manager.query(
      `
      UPDATE sessions SET revoked_at = COALESCE(revoked_at, clock_timestamp()), ended_at = COALESCE(ended_at, clock_timestamp()),
        revocation_reason = $2 WHERE id = $1
    `,
      [sessionId, reason],
    );
    await manager.query(
      'UPDATE session_refresh_tokens SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE session_id = $1',
      [sessionId],
    );
    await this.audit(
      manager,
      userId,
      application,
      reason === 'refresh_reuse_detected'
        ? reason
        : reason === 'sign_out'
          ? 'sign_out'
          : 'session_revoked',
      reason,
    );
  }

  async logout(
    rawToken: string | undefined,
    application: Application,
    accessToken?: string,
  ): Promise<void> {
    const claims =
      !rawToken && accessToken
        ? await this.tokens.readAccess(accessToken, application)
        : null;
    if (!rawToken && !claims) return;
    await this.database.transaction(async (manager) => {
      const [session] = await manager.query<{ id: string; userId: string }[]>(
        `
        SELECT s.id, s.user_id AS "userId" FROM sessions s
        WHERE s.application = $2 AND s.ended_at IS NULL AND (
          EXISTS (SELECT 1 FROM session_refresh_tokens t WHERE t.session_id = s.id AND t.token_hash = $1)
          OR (s.id = $3 AND s.user_id = $4)
        ) FOR UPDATE OF s
      `,
        [
          rawToken ? tokenHash(rawToken) : null,
          application,
          claims?.sid ?? null,
          claims?.sub ?? null,
        ],
      );
      if (session)
        await this.revoke(
          manager,
          session.id,
          session.userId,
          application,
          'sign_out',
        );
    });
  }

  async listSessions(context: AuthSession) {
    return this.database.query<
      {
        id: string;
        createdAt: Date;
        lastSeenAt: Date;
        expiresAt: Date;
        current: boolean;
      }[]
    >(
      `
      SELECT id, created_at AS "createdAt", last_seen_at AS "lastSeenAt", expires_at AS "expiresAt",
        (id = $3) AS current FROM sessions
      WHERE user_id = $1 AND application = $2 AND ended_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC
    `,
      [context.user.id, context.application, context.id],
    );
  }

  async revokeSession(context: AuthSession, sessionId: string): Promise<void> {
    await this.database.transaction(async (manager) => {
      const rows = await manager.query<{ id: string }[]>(
        'SELECT id FROM sessions WHERE id = $1 AND user_id = $2 AND application = $3 FOR UPDATE',
        [sessionId, context.user.id, context.application],
      );
      if (rows.length === 0)
        throw new ForbiddenException('No puedes gestionar esta sesion.');
      await this.revoke(
        manager,
        sessionId,
        context.user.id,
        context.application,
        'user_revoked',
      );
    });
  }

  async updateProfile(
    context: AuthSession,
    changes: ProfileUpdate,
  ): Promise<AuthSession> {
    await this.database.query(
      `
      UPDATE users SET
        given_name = CASE WHEN $2 THEN $3 ELSE given_name END,
        family_name = CASE WHEN $4 THEN $5 ELSE family_name END,
        display_name = CASE WHEN $6 THEN $7 ELSE display_name END,
        phone = CASE WHEN $8 THEN $9 ELSE phone END,
        locale = COALESCE($10, locale), time_zone = COALESCE($11, time_zone)
      WHERE id = $1 AND status = 'active'
    `,
      [
        context.user.id,
        'givenName' in changes,
        changes.givenName ?? null,
        'familyName' in changes,
        changes.familyName ?? null,
        'displayName' in changes,
        changes.displayName ?? null,
        'phone' in changes,
        changes.phone ?? null,
        changes.locale ?? null,
        changes.timeZone ?? null,
      ],
    );
    return this.context(
      this.database.manager,
      context.id,
      context.application,
      context.user.id,
    );
  }
}
