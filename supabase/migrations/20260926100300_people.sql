-- PRD 4, 8.1, D6: Knit users. Every row belongs to one Supabase Auth user, and only the admin
-- creates them (no self sign-up).
create table public.app_users (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  email text not null unique,
  role text not null check (role in ('admin', 'member')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- PRD 6.7: owner names used in trackers, mapped to a user, or to a known non-user when
-- user_id is null (Sales, Creative, Agent, teammates before Stage 3). Names are stored
-- normalised so matching never depends on case or spacing.
create table public.people_aliases (
  alias_norm text primary key,
  display text not null,
  user_id uuid references public.app_users (id),
  created_at timestamptz not null default now(),
  constraint people_aliases_alias_is_normalised
    check (alias_norm <> '' and alias_norm = public.knit_normalise(alias_norm))
);

create index people_aliases_user_id_idx on public.people_aliases (user_id);

-- PRD 9.2: the caller is the active admin. Security definer so policies can use it without
-- granting access to app_users.
create function public.knit_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from app_users where id = auth.uid() and role = 'admin' and is_active
  )
$$;

-- The caller is an active Knit user (admin or member). A deactivated user sees nothing.
create function public.knit_is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from app_users where id = auth.uid() and is_active)
$$;

revoke all on function public.knit_is_admin() from public, anon;
revoke all on function public.knit_is_active_user() from public, anon;
grant execute on function public.knit_is_admin() to authenticated, service_role;
grant execute on function public.knit_is_active_user() to authenticated, service_role;
