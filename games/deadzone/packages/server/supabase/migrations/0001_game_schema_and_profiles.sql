-- 0001_game_schema_and_profiles
-- OVERRUN backend: dedicated `game` schema + player profiles.
-- Nothing in this file touches the `public` schema.

create schema if not exists game;

-- anon needs USAGE so it can reach the public leaderboard views.
-- authenticated needs USAGE for everything else. Table-level grants are
-- issued per table below (schema usage alone grants nothing).
grant usage on schema game to anon, authenticated, service_role;

-- Do NOT let PostgREST roles create objects in this schema.
revoke create on schema game from anon, authenticated;

-- ---------------------------------------------------------------- profiles
create table if not exists game.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  handle        text not null unique,
  display_name  text,
  avatar_seed   int not null default 0,
  skin          int not null default 0,
  level         int not null default 1,
  xp            int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint profiles_handle_len   check (char_length(handle) between 3 and 16),
  constraint profiles_handle_chars check (handle ~ '^[A-Za-z0-9_]+$'),
  constraint profiles_xp_nonneg    check (xp >= 0),
  constraint profiles_level_min    check (level >= 1)
);

comment on table game.profiles is
  'OVERRUN player profile, 1:1 with auth.users. Rows are created by the
   on_auth_user_created trigger; clients may never INSERT or DELETE.';

-- ------------------------------------------------------- updated_at trigger
create or replace function game.tg_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on game.profiles;
create trigger set_updated_at
  before update on game.profiles
  for each row execute function game.tg_set_updated_at();

-- --------------------------------------------- auto-provision on auth signup
-- Generates 'runner_xxxxxx'. Retries on collision, then falls back to a
-- uuid-derived handle which is unique by construction. Never blocks signup.
create or replace function game.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_handle text;
  v_try    int := 0;
begin
  loop
    v_handle := 'runner_' || substr(md5(random()::text), 1, 6);
    exit when not exists (select 1 from game.profiles p where p.handle = v_handle);
    v_try := v_try + 1;
    if v_try >= 20 then
      -- 'runner_' (7) + 9 hex chars = 16 chars, the max allowed length.
      v_handle := 'runner_' || substr(replace(new.id::text, '-', ''), 1, 9);
      exit;
    end if;
  end loop;

  insert into game.profiles (id, handle)
  values (new.id, v_handle)
  on conflict (id) do nothing;

  return new;
exception
  when unique_violation then
    -- Lost a race on the handle. Fall back to the uuid-derived handle.
    begin
      insert into game.profiles (id, handle)
      values (new.id, 'runner_' || substr(replace(new.id::text, '-', ''), 1, 9))
      on conflict (id) do nothing;
    exception when others then
      null;
    end;
    return new;
  when others then
    -- A profile problem must never break authentication.
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function game.handle_new_user();

-- ------------------------------------------------------------------- RLS
alter table game.profiles enable row level security;

-- Handles are public to signed-in players (scoreboards, friend search).
create policy profiles_select_authenticated
  on game.profiles for select to authenticated
  using (true);

-- Owner may edit their own row. Column-level grants below restrict *which*
-- columns; xp/level are server-authoritative and not client-writable.
create policy profiles_update_own
  on game.profiles for update to authenticated
  using  ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- No INSERT policy (the trigger owns creation) and no DELETE policy
-- (cascade from auth.users owns removal).

grant select on game.profiles to authenticated;
grant update (handle, display_name, avatar_seed, skin) on game.profiles to authenticated;
grant all on game.profiles to service_role;
