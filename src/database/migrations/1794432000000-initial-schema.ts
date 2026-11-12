import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1794432000000 implements MigrationInterface {
  name = 'InitialSchema1794432000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL CHECK (btrim(email) <> ''),
        email_verified boolean NOT NULL DEFAULT false,
        given_name text NOT NULL CHECK (btrim(given_name) <> ''),
        family_name text,
        display_name text,
        avatar_url text,
        phone text,
        locale text NOT NULL DEFAULT 'es',
        time_zone text NOT NULL DEFAULT 'UTC',
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'inactive')),
        last_login_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX users_email_unique ON users (lower(btrim(email)));

      CREATE TABLE auth_identities (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        provider text NOT NULL DEFAULT 'google' CHECK (provider = 'google'),
        subject text NOT NULL CHECK (btrim(subject) <> ''),
        email text NOT NULL,
        email_verified boolean NOT NULL DEFAULT false,
        given_name text,
        family_name text,
        avatar_url text,
        synced_at timestamptz NOT NULL DEFAULT now(),
        linked_at timestamptz NOT NULL DEFAULT now(),
        link_origin text NOT NULL DEFAULT 'google_sign_in'
          CHECK (link_origin IN ('google_sign_in', 'account_link', 'migration')),
        UNIQUE (provider, subject),
        UNIQUE (user_id, provider)
      );

      CREATE TABLE platform_admins (
        user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
        role text NOT NULL CHECK (role IN ('admin', 'support')),
        granted_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        granted_at timestamptz NOT NULL DEFAULT now(),
        revoked_at timestamptz,
        CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
      );

      CREATE TABLE sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        application text NOT NULL CHECK (application IN ('user', 'admin')),
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        ended_at timestamptz,
        revoked_at timestamptz,
        revocation_reason text,
        CHECK (expires_at > created_at),
        CHECK (ended_at IS NULL OR ended_at >= created_at),
        CHECK (revoked_at IS NULL OR revoked_at >= created_at)
      );
      CREATE INDEX sessions_user_idx ON sessions(user_id, application);
      CREATE INDEX sessions_expiry_idx ON sessions(expires_at) WHERE revoked_at IS NULL AND ended_at IS NULL;

      CREATE TABLE session_refresh_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        rotated_from_id uuid UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        revoked_at timestamptz,
        UNIQUE (session_id, id),
        FOREIGN KEY (session_id, rotated_from_id)
          REFERENCES session_refresh_tokens(session_id, id) ON DELETE RESTRICT,
        CHECK (rotated_from_id IS NULL OR rotated_from_id <> id),
        CHECK (expires_at > created_at),
        CHECK (used_at IS NULL OR used_at >= created_at),
        CHECK (revoked_at IS NULL OR revoked_at >= created_at)
      );
      CREATE INDEX refresh_tokens_session_idx ON session_refresh_tokens(session_id);

      CREATE TABLE auth_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        event_type text NOT NULL CHECK (event_type IN (
          'sign_in', 'sign_in_failed', 'sign_out', 'session_revoked',
          'refresh_rotated', 'refresh_reuse_detected', 'identity_linked', 'identity_unlinked',
          'admin_granted', 'admin_revoked'
        )),
        application text NOT NULL CHECK (application IN ('user', 'admin')),
        reason_code text,
        occurred_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX auth_events_user_time_idx ON auth_events(user_id, occurred_at DESC);

      CREATE TABLE workspaces (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind text NOT NULL CHECK (kind IN ('personal', 'business')),
        name text NOT NULL CHECK (btrim(name) <> ''),
        owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        legal_name text,
        tax_id text,
        time_zone text NOT NULL DEFAULT 'UTC',
        archived_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (kind = 'business' OR (legal_name IS NULL AND tax_id IS NULL))
      );
      CREATE UNIQUE INDEX workspaces_personal_owner_unique ON workspaces(owner_user_id) WHERE kind = 'personal';
      CREATE INDEX workspaces_owner_idx ON workspaces(owner_user_id);

      CREATE TABLE workspace_members (
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        joined_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, user_id)
      );
      CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);
      ALTER TABLE workspaces ADD CONSTRAINT workspaces_owner_membership_fk
        FOREIGN KEY (id, owner_user_id) REFERENCES workspace_members(workspace_id, user_id)
        DEFERRABLE INITIALLY DEFERRED;

      CREATE FUNCTION validate_workspace_member() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM workspaces
          WHERE id = NEW.workspace_id AND kind = 'personal' AND owner_user_id <> NEW.user_id
        ) THEN
          RAISE EXCEPTION 'A personal workspace only admits its owner' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER workspace_members_personal_guard
        BEFORE INSERT OR UPDATE ON workspace_members
        FOR EACH ROW EXECUTE FUNCTION validate_workspace_member();

      CREATE FUNCTION protect_workspace_kind() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.kind <> OLD.kind OR (OLD.kind = 'personal' AND NEW.owner_user_id <> OLD.owner_user_id) THEN
          RAISE EXCEPTION 'Workspace kind and personal ownership are immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER workspaces_kind_guard BEFORE UPDATE ON workspaces
        FOR EACH ROW EXECUTE FUNCTION protect_workspace_kind();

      CREATE TABLE properties (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        name text NOT NULL CHECK (btrim(name) <> ''),
        kind text NOT NULL CHECK (kind IN ('house', 'apartment', 'building', 'commercial', 'other')),
        address_line1 text NOT NULL CHECK (btrim(address_line1) <> ''),
        address_line2 text,
        city text,
        region text,
        postal_code text,
        country_code text CHECK (country_code ~ '^[A-Z]{2}$'),
        time_zone text NOT NULL DEFAULT 'UTC',
        area_m2 numeric(12,2) CHECK (area_m2 > 0),
        notes text,
        archived_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, id)
      );
      CREATE INDEX properties_workspace_idx ON properties(workspace_id);

      CREATE TABLE property_spaces (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL,
        property_id uuid NOT NULL,
        name text NOT NULL CHECK (btrim(name) <> ''),
        floor_label text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, property_id, id),
        FOREIGN KEY (workspace_id, property_id) REFERENCES properties(workspace_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE asset_categories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
        name text NOT NULL CHECK (btrim(name) <> ''),
        description text
      );

      CREATE TABLE assets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL,
        property_id uuid NOT NULL,
        space_id uuid,
        category_id uuid REFERENCES asset_categories(id) ON DELETE RESTRICT,
        kind text NOT NULL CHECK (kind IN ('equipment', 'installation')),
        name text NOT NULL CHECK (btrim(name) <> ''),
        brand text,
        model text,
        serial_number text,
        installed_on date,
        warranty_expires_on date,
        condition text NOT NULL DEFAULT 'unknown'
          CHECK (condition IN ('unknown', 'good', 'needs_attention', 'critical', 'out_of_service')),
        notes text,
        archived_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, id),
        UNIQUE (workspace_id, property_id, id),
        FOREIGN KEY (workspace_id, property_id) REFERENCES properties(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, property_id, space_id)
          REFERENCES property_spaces(workspace_id, property_id, id) ON DELETE RESTRICT,
        CHECK (warranty_expires_on IS NULL OR installed_on IS NULL OR warranty_expires_on >= installed_on)
      );
      CREATE INDEX assets_property_idx ON assets(workspace_id, property_id);
      CREATE INDEX assets_space_idx ON assets(workspace_id, property_id, space_id);
      CREATE INDEX assets_category_idx ON assets(category_id);

      CREATE TABLE maintenance_plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL,
        property_id uuid NOT NULL,
        asset_id uuid,
        title text NOT NULL CHECK (btrim(title) <> ''),
        description text,
        priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        recurrence_unit text NOT NULL CHECK (recurrence_unit IN ('day', 'week', 'month', 'year')),
        recurrence_interval integer NOT NULL CHECK (recurrence_interval > 0),
        starts_on date NOT NULL,
        ends_on date,
        next_due_at timestamptz NOT NULL,
        time_zone text NOT NULL DEFAULT 'UTC',
        estimated_minutes integer CHECK (estimated_minutes > 0),
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, id),
        UNIQUE (workspace_id, property_id, id),
        FOREIGN KEY (workspace_id, property_id) REFERENCES properties(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, property_id, asset_id)
          REFERENCES assets(workspace_id, property_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, created_by) REFERENCES workspace_members(workspace_id, user_id) ON DELETE RESTRICT,
        CHECK (ends_on IS NULL OR ends_on >= starts_on)
      );
      CREATE INDEX plans_property_idx ON maintenance_plans(workspace_id, property_id);
      CREATE INDEX plans_asset_idx ON maintenance_plans(workspace_id, property_id, asset_id);
      CREATE INDEX plans_creator_idx ON maintenance_plans(workspace_id, created_by);
      CREATE INDEX plans_calendar_idx ON maintenance_plans(workspace_id, next_due_at) WHERE status = 'active';

      CREATE TABLE maintenance_plan_tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL,
        plan_id uuid NOT NULL,
        title text NOT NULL CHECK (btrim(title) <> ''),
        instructions text,
        position integer NOT NULL CHECK (position >= 0),
        UNIQUE (workspace_id, plan_id, position),
        FOREIGN KEY (workspace_id, plan_id) REFERENCES maintenance_plans(workspace_id, id) ON DELETE CASCADE
      );

      CREATE TABLE work_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL,
        property_id uuid NOT NULL,
        asset_id uuid,
        plan_id uuid,
        scheduled_for timestamptz,
        title text NOT NULL CHECK (btrim(title) <> ''),
        description text,
        priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        status text NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
        due_at timestamptz NOT NULL,
        started_at timestamptz,
        completed_at timestamptz,
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, id),
        UNIQUE (workspace_id, property_id, id),
        UNIQUE (workspace_id, plan_id, scheduled_for),
        FOREIGN KEY (workspace_id, property_id) REFERENCES properties(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, property_id, asset_id)
          REFERENCES assets(workspace_id, property_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, property_id, plan_id)
          REFERENCES maintenance_plans(workspace_id, property_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, created_by) REFERENCES workspace_members(workspace_id, user_id) ON DELETE RESTRICT,
        CHECK ((plan_id IS NULL) = (scheduled_for IS NULL)),
        CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
        CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
      );
      CREATE INDEX orders_property_idx ON work_orders(workspace_id, property_id);
      CREATE INDEX orders_asset_idx ON work_orders(workspace_id, property_id, asset_id);
      CREATE INDEX orders_creator_idx ON work_orders(workspace_id, created_by);
      CREATE INDEX orders_calendar_idx ON work_orders(workspace_id, due_at, status);

      CREATE TABLE work_order_assignees (
        workspace_id uuid NOT NULL,
        work_order_id uuid NOT NULL,
        user_id uuid NOT NULL,
        assigned_by uuid NOT NULL,
        assigned_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, work_order_id, user_id),
        FOREIGN KEY (workspace_id, work_order_id) REFERENCES work_orders(workspace_id, id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, assigned_by) REFERENCES workspace_members(workspace_id, user_id) ON DELETE RESTRICT
      );
      CREATE INDEX assignees_user_idx ON work_order_assignees(workspace_id, user_id);
      CREATE INDEX assignees_assigner_idx ON work_order_assignees(workspace_id, assigned_by);

      CREATE TABLE work_order_tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL,
        work_order_id uuid NOT NULL,
        title text NOT NULL CHECK (btrim(title) <> ''),
        instructions text,
        position integer NOT NULL CHECK (position >= 0),
        completed_at timestamptz,
        completed_by uuid,
        UNIQUE (workspace_id, work_order_id, position),
        FOREIGN KEY (workspace_id, work_order_id) REFERENCES work_orders(workspace_id, id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, completed_by) REFERENCES workspace_members(workspace_id, user_id) ON DELETE RESTRICT,
        CHECK ((completed_at IS NULL) = (completed_by IS NULL))
      );
      CREATE INDEX order_tasks_completer_idx ON work_order_tasks(workspace_id, completed_by);

      CREATE TABLE work_order_activities (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL,
        work_order_id uuid NOT NULL,
        actor_user_id uuid NOT NULL,
        kind text NOT NULL CHECK (kind IN ('created', 'status_changed', 'assigned', 'comment', 'task_completed')),
        body text NOT NULL CHECK (btrim(body) <> ''),
        occurred_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (workspace_id, work_order_id) REFERENCES work_orders(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, actor_user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE RESTRICT
      );
      CREATE INDEX activities_order_idx ON work_order_activities(workspace_id, work_order_id, occurred_at);
      CREATE INDEX activities_actor_idx ON work_order_activities(workspace_id, actor_user_id);

      CREATE TABLE maintenance_records (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL,
        property_id uuid NOT NULL,
        asset_id uuid,
        work_order_id uuid,
        performed_by uuid NOT NULL,
        performed_at timestamptz NOT NULL,
        summary text NOT NULL CHECK (btrim(summary) <> ''),
        notes text,
        cost numeric(14,2) CHECK (cost >= 0),
        currency_code text CHECK (currency_code ~ '^[A-Z]{3}$'),
        duration_minutes integer CHECK (duration_minutes > 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, work_order_id),
        FOREIGN KEY (workspace_id, property_id) REFERENCES properties(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, property_id, asset_id)
          REFERENCES assets(workspace_id, property_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, property_id, work_order_id)
          REFERENCES work_orders(workspace_id, property_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, performed_by) REFERENCES workspace_members(workspace_id, user_id) ON DELETE RESTRICT,
        CHECK ((cost IS NULL) = (currency_code IS NULL))
      );
      CREATE INDEX records_history_idx ON maintenance_records(workspace_id, property_id, performed_at DESC);
      CREATE INDEX records_asset_idx ON maintenance_records(workspace_id, property_id, asset_id);
      CREATE INDEX records_performer_idx ON maintenance_records(workspace_id, performed_by);

      CREATE TABLE reminders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL,
        recipient_user_id uuid NOT NULL,
        plan_id uuid,
        work_order_id uuid,
        remind_at timestamptz NOT NULL,
        channel text NOT NULL CHECK (channel IN ('in_app', 'email')),
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
        sent_at timestamptz,
        attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error_code text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (workspace_id, recipient_user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, plan_id) REFERENCES maintenance_plans(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, work_order_id) REFERENCES work_orders(workspace_id, id) ON DELETE RESTRICT,
        CHECK (num_nonnulls(plan_id, work_order_id) = 1),
        CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
        UNIQUE (workspace_id, recipient_user_id, plan_id, remind_at, channel),
        UNIQUE (workspace_id, recipient_user_id, work_order_id, remind_at, channel)
      );
      CREATE INDEX reminders_delivery_idx ON reminders(remind_at) WHERE status = 'pending';
      CREATE INDEX reminders_recipient_idx ON reminders(workspace_id, recipient_user_id);
      CREATE INDEX reminders_plan_idx ON reminders(workspace_id, plan_id);
      CREATE INDEX reminders_order_idx ON reminders(workspace_id, work_order_id);

      CREATE TABLE knowledge_categories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
        name text NOT NULL CHECK (btrim(name) <> '')
      );
      CREATE TABLE knowledge_articles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        category_id uuid NOT NULL REFERENCES knowledge_categories(id) ON DELETE RESTRICT,
        asset_category_id uuid REFERENCES asset_categories(id) ON DELETE RESTRICT,
        slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
        title text NOT NULL CHECK (btrim(title) <> ''),
        summary text NOT NULL,
        content text NOT NULL,
        status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
        author_user_id uuid NOT NULL REFERENCES platform_admins(user_id) ON DELETE RESTRICT,
        published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (status <> 'published' OR published_at IS NOT NULL)
      );
      CREATE INDEX articles_category_idx ON knowledge_articles(category_id);
      CREATE INDEX articles_asset_category_idx ON knowledge_articles(asset_category_id);
      CREATE INDEX articles_author_idx ON knowledge_articles(author_user_id);
      CREATE INDEX articles_published_idx ON knowledge_articles(published_at DESC) WHERE status = 'published';

      CREATE TABLE maintenance_recommendations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL,
        asset_id uuid NOT NULL,
        article_id uuid REFERENCES knowledge_articles(id) ON DELETE RESTRICT,
        title text NOT NULL CHECK (btrim(title) <> ''),
        reason text NOT NULL CHECK (btrim(reason) <> ''),
        priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'accepted', 'dismissed')),
        suggested_due_at timestamptz,
        resolved_by uuid,
        resolved_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (workspace_id, asset_id) REFERENCES assets(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, resolved_by) REFERENCES workspace_members(workspace_id, user_id) ON DELETE RESTRICT,
        CHECK ((status = 'new') = (resolved_at IS NULL)),
        CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
      );
      CREATE INDEX recommendations_asset_idx ON maintenance_recommendations(workspace_id, asset_id);
      CREATE INDEX recommendations_article_idx ON maintenance_recommendations(article_id);
      CREATE INDEX recommendations_resolver_idx ON maintenance_recommendations(workspace_id, resolved_by);

      CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.updated_at = clock_timestamp();
        RETURN NEW;
      END;
      $$;
      DO $$
      DECLARE table_name text;
      BEGIN
        FOREACH table_name IN ARRAY ARRAY[
          'users', 'workspaces', 'workspace_members', 'properties', 'property_spaces',
          'assets', 'maintenance_plans', 'work_orders', 'reminders',
          'knowledge_articles', 'maintenance_recommendations'
        ] LOOP
          EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', table_name);
        END LOOP;
      END;
      $$;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE maintenance_recommendations;
      DROP TABLE knowledge_articles;
      DROP TABLE knowledge_categories;
      DROP TABLE reminders;
      DROP TABLE maintenance_records;
      DROP TABLE work_order_activities;
      DROP TABLE work_order_tasks;
      DROP TABLE work_order_assignees;
      DROP TABLE work_orders;
      DROP TABLE maintenance_plan_tasks;
      DROP TABLE maintenance_plans;
      DROP TABLE assets;
      DROP TABLE asset_categories;
      DROP TABLE property_spaces;
      DROP TABLE properties;
      ALTER TABLE workspaces DROP CONSTRAINT workspaces_owner_membership_fk;
      DROP TABLE workspace_members;
      DROP TABLE workspaces;
      DROP FUNCTION validate_workspace_member();
      DROP FUNCTION protect_workspace_kind();
      DROP TABLE auth_events;
      ALTER TABLE session_refresh_tokens DROP CONSTRAINT session_refresh_tokens_session_id_rotated_from_id_fkey;
      DROP TABLE session_refresh_tokens;
      DROP TABLE sessions;
      DROP TABLE platform_admins;
      DROP TABLE auth_identities;
      DROP TABLE users;
      DROP FUNCTION set_updated_at();
    `);
  }
}
