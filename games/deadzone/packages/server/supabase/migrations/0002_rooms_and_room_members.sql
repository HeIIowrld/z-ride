-- 0002_rooms_and_room_members
-- Lobby tables. These are the only two tables published to Realtime.

-- ------------------------------------------------------------------- rooms
create table if not exists game.rooms (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  mode          text not null check (mode in ('coop','tdm','squad')),
  host_id       uuid references game.profiles(id) on delete set null,
  is_public     boolean not null default false,
  state         text not null default 'lobby' check (state in ('lobby','playing','ended')),
  max_players   int not null default 8 check (max_players between 1 and 64),
  player_count  int not null default 0 check (player_count >= 0),
  created_at    timestamptz not null default now(),
  last_active   timestamptz not null default now(),
  constraint rooms_code_len   check (char_length(code) = 6),
  constraint rooms_code_chars check (code ~ '^[A-Z0-9]{6}$')
);

create index if not exists rooms_browse_idx  on game.rooms (mode, is_public, state);
create index if not exists rooms_host_idx    on game.rooms (host_id);
create index if not exists rooms_active_idx  on game.rooms (last_active desc);
-- `code` is already backed by a unique index from the UNIQUE constraint.

-- ------------------------------------------------------------ room_members
create table if not exists game.room_members (
  room_id     uuid not null references game.rooms(id) on delete cascade,
  profile_id  uuid not null references game.profiles(id) on delete cascade,
  team        int not null default 0,
  ready       boolean not null default false,
  joined_at   timestamptz not null default now(),
  primary key (room_id, profile_id)
);

-- room_id is covered by the leading column of the composite PK.
create index if not exists room_members_profile_idx on game.room_members (profile_id);

-- ------------------------------------------------------------- helpers
-- SECURITY DEFINER so the rooms/room_members policies can ask "is this user in
-- that room?" without the two policies recursing into each other.
create or replace function game.is_room_member(p_room_id uuid, p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from game.room_members m
    where m.room_id = p_room_id and m.profile_id = p_profile_id
  );
$$;

-- Join-by-code. RLS cannot express "a room whose code you happen to know",
-- so knowing the exact code is proven by calling this RPC with it.
create or replace function game.room_by_code(p_code text)
returns setof game.rooms
language sql
stable
security definer
set search_path = ''
as $$
  select r.* from game.rooms r
  where r.code = upper(p_code)
    and r.state <> 'ended'
  limit 1;
$$;

-- Collision-free 6-char room code generator, for use as a client-side default.
create or replace function game.new_room_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_try  int := 0;
begin
  loop
    v_code := upper(substr(md5(random()::text), 1, 6));
    exit when not exists (select 1 from game.rooms r where r.code = v_code);
    v_try := v_try + 1;
    if v_try > 50 then
      raise exception 'could not allocate a unique room code';
    end if;
  end loop;
  return v_code;
end;
$$;

alter table game.rooms alter column code set default game.new_room_code();

-- ------------------------------------------------------------------- RLS
alter table game.rooms        enable row level security;
alter table game.room_members enable row level security;

-- Rooms: public rooms are browsable; private rooms only by host/members
-- (or via game.room_by_code for people who were given the code).
create policy rooms_select
  on game.rooms for select to authenticated
  using (
    is_public
    or host_id = (select auth.uid())
    or game.is_room_member(id, (select auth.uid()))
  );

create policy rooms_insert_own_host
  on game.rooms for insert to authenticated
  with check (host_id = (select auth.uid()));

create policy rooms_update_host
  on game.rooms for update to authenticated
  using  (host_id = (select auth.uid()))
  with check (host_id = (select auth.uid()));

create policy rooms_delete_host
  on game.rooms for delete to authenticated
  using (host_id = (select auth.uid()));

-- Members: you see your own membership rows and everyone in rooms you are in.
create policy room_members_select
  on game.room_members for select to authenticated
  using (
    profile_id = (select auth.uid())
    or game.is_room_member(room_id, (select auth.uid()))
  );

create policy room_members_insert_self
  on game.room_members for insert to authenticated
  with check (profile_id = (select auth.uid()));

create policy room_members_update_self
  on game.room_members for update to authenticated
  using  (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

create policy room_members_delete_self
  on game.room_members for delete to authenticated
  using (profile_id = (select auth.uid()));

grant select, insert, update, delete on game.rooms        to authenticated;
grant select, insert, update, delete on game.room_members to authenticated;
grant all on game.rooms        to service_role;
grant all on game.room_members to service_role;

grant execute on function game.room_by_code(text)         to authenticated;
grant execute on function game.new_room_code()            to authenticated;
grant execute on function game.is_room_member(uuid, uuid) to authenticated;
