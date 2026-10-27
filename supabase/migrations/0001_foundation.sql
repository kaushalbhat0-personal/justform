-- FORMOS migration 0001 — foundation & conventions (Phase 0).
--
-- CONVENTIONS (normative for all future migrations):
--   1. Plain SQL, one transaction per file (Supabase CLI compatible).
--   2. Extension policy: NO extensions in the tenancy/authz path. pgcrypto etc.
--      may be used only outside RLS/RPC hot paths and must be declared here.
--      This migration uses ZERO extensions (ids are generated app-side as UUIDv7).
--   3. All helper functions: SECURITY DEFINER only where needed, ALWAYS with
--      fixed `SET search_path = pg_catalog, pg_temp`, fully-qualified object
--      references, strict parameter types, no dynamic SQL.
--   4. Timestamps: created_at/updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
--      updated_at maintained by formos.set_updated_at() trigger.
--   5. IDs: UUID primary keys, generated app-side (UUIDv7). No DB defaults.
--   6. Every tenant table: workspace_id UUID NOT NULL (Rule 1) except the six
--      Rule-2 inheritors; workspace_id IMMUTABLE via prevent trigger (Rule 3).
--   7. RLS: ENABLE + FORCE ROW LEVEL SECURITY on every tenant table; deny by
--      default (no policy = no access). REVOKE ALL from anon/authenticated first,
--      then grant minimal per-policy needs.
--   8. Composite FKs (workspace_id, parent_id) wherever both sides carry it.
--   9. Soft-delete app data; hard-delete only ephemeral/logs by retention.
--      (No soft-delete columns in Phase 0 tables; added with product tables.)

CREATE SCHEMA IF NOT EXISTS formos;

-- updated_at maintenance (generic, fixed search_path).
CREATE OR REPLACE FUNCTION formos.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- workspace_id immutability (Rule 3). Attach to every table carrying workspace_id.
CREATE OR REPLACE FUNCTION formos.prevent_workspace_id_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'workspace_id is immutable (move = clone operation)';
  END IF;
  RETURN NEW;
END;
$$;
