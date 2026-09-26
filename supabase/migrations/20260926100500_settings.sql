-- PRD 8.1: small key-value settings (for example go-live defaults). Admin reads only (9.2).
create table public.settings (
  key text primary key,
  value jsonb not null
);
