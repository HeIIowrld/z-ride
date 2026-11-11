-- 0003_matches_and_match_players
-- Authoritative match results. Clients may READ these, never WRITE them.
-- The only writer is the service_role (the submit-match edge function),
-- which bypasses RLS. There is deliberately no INSERT/UPDATE/DELETE policy:
-- that is the whole anti-cheat story on the database side.

create table if not exists game.matches (
  id                     uuid primary key default gen_random_uuid(),
  room_code              text,
  mode                   text not null check (mode in ('coop','tdm','squad')),
  seed                   bigint,
  started_at             timestamptz not null default now(),
  ended_at               timestamptz,
  duration_seconds       int check (duration_seconds >= 0),
  winning_team           int,
  wave_reached           int check (wave_reached >= 0),
  server_secret_verified boolean not null default false,
  created_at             timestamptz not null default now()
);

create index if not exists matches_started_idx on game.matches (started_at desc);
create index if not exists matches_mode_idx    on game.matches (mode, started_at desc);

create table if not exists game.match_players (
  id            uuid primary key default gen_random_uuid(),
  match_id      uuid not null references game.matches(id) on delete cascade,
  profile_id    uuid references game.profiles(id) on delete set null,
  display_name  text not null,
  is_bot        boolean not null default false,
  team          int not null default 0,
  kills         int not null default 0 check (kills   >= 0),
  deaths        int not null default 0 check (deaths  >= 0),
  assists       int not null default 0 check (assists >= 0),
  score         int not null default 0,
  damage_dealt  int not null default 0 check (damage_dealt >= 0),
  accuracy      real check (accuracy >= 0 and accuracy <= 1),
  xp_awarded    int not null default 0 check (xp_awarded >= 0),
  created_at    timestamptz not null default now()
);

-- A registered player appears at most once per match. Guests and bots
-- (profile_id is null) are exempt, which is why this is a partial index
-- rather than a composite primary key on (match_id, display_name).
create unique index if not exists match_players_match_profile_uidx
  on game.match_players (match_id, profile_id)
  where profile_id is not null;

create index if not exists match_players_match_idx   on game.match_players (match_id);
create index if not exists match_players_profile_idx on game.match_players (profile_id);

alter table game.matches       enable row level security;
alter table game.match_players enable row level security;

create policy matches_select_authenticated
  on game.matches for select to authenticated
  using (true);

create policy match_players_select_authenticated
  on game.match_players for select to authenticated
  using (true);

-- Read-only for players. No write grant is issued to `authenticated` at all,
-- so even a policy mistake later cannot let a client write its own results.
grant select on game.matches       to authenticated;
grant select on game.match_players to authenticated;
grant all on game.matches       to service_role;
grant all on game.match_players to service_role;
