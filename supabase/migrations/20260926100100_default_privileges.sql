-- PRD 9.2, CLAUDE.md invariants 9 and 10: least privilege by default.
--
-- Supabase grants the Data API roles (anon, authenticated, service_role) everything on new
-- objects in `public`, and Postgres lets PUBLIC execute every new function. Knit narrows that
-- for every object created from here on:
--   * anon gets nothing: Knit has no public data.
--   * authenticated may read tables (row level security then filters rows) but never writes
--     directly: changes go through RPC functions or the server's service role.
--   * no function is executable until a migration grants it explicitly.
-- Each migration still revokes and grants explicitly, so safety never rests on these defaults.

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- The PUBLIC execute grant on functions is global, so it can only be revoked globally.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
