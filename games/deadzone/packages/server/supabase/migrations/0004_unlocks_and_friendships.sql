-- 0004_unlocks_and_friendships
-- Cosmetic/weapon unlocks (server-granted) and the social graph.

-- ----------------------------------------------------------------- unlocks
create table if not exists game.unlocks (
  profile_id  uuid not null references game.profiles(id) on delete cascade,
  item_id     text not null check (char_length(item_id) between 1 and 64),
  unlocked_at timestamptz not null default now(),
  primary key (profile_id, item_id)
);

-- profile_id is covered by the leading column of the composite PK.
create index if not exists unlocks_item_idx on game.unlocks (item_id);

alter table game.unlocks enable row level security;

create policy unlocks_select_own
  on game.unlocks for select to authenticated
  using (profile_id = (select auth.uid()));

-- No write policies: unlocks are granted server-side only.
grant select on game.unlocks to authenticated;
grant all on game.unlocks to service_role;

-- -------------------------------------------------------------- friendships
-- One row per direction. A request is (requester -> addressee, 'pending');
-- accepting flips it to 'accepted' and writes the mirror row so that both
-- sides can list their friends with a single-column lookup.
create table if not exists game.friendships (
  profile_id  uuid not null references game.profiles(id) on delete cascade,
  friend_id   uuid not null references game.profiles(id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending','accepted','blocked')),
  created_at  timestamptz not null default now(),
  primary key (profile_id, friend_id),
  constraint friendships_no_self check (profile_id <> friend_id)
);

create index if not exists friendships_friend_idx on game.friendships (friend_id, status);

alter table game.friendships enable row level security;

-- You can see any row you are on either side of.
create policy friendships_select_either_side
  on game.friendships for select to authenticated
  using (
    profile_id = (select auth.uid())
    or friend_id = (select auth.uid())
  );

-- You may only write rows where YOU are the requester (the left-hand side).
create policy friendships_insert_as_requester
  on game.friendships for insert to authenticated
  with check (profile_id = (select auth.uid()));

create policy friendships_update_as_requester
  on game.friendships for update to authenticated
  using  (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

create policy friendships_delete_as_requester
  on game.friendships for delete to authenticated
  using (profile_id = (select auth.uid()));

grant select, insert, update, delete on game.friendships to authenticated;
grant all on game.friendships to service_role;

-- Accepting/declining touches the requester's row, which the policies above
-- deliberately forbid. This RPC is the sanctioned, narrow exception: it can
-- only ever act on a pending request addressed to the caller.
create or replace function game.respond_to_friend_request(p_requester uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if not p_accept then
    delete from game.friendships f
    where f.profile_id = p_requester and f.friend_id = v_me and f.status = 'pending';
    return;
  end if;

  update game.friendships f
     set status = 'accepted'
   where f.profile_id = p_requester
     and f.friend_id = v_me
     and f.status = 'pending';

  if not found then
    raise exception 'no pending friend request from %', p_requester using errcode = 'P0002';
  end if;

  insert into game.friendships (profile_id, friend_id, status)
  values (v_me, p_requester, 'accepted')
  on conflict (profile_id, friend_id) do update set status = 'accepted';
end;
$$;

grant execute on function game.respond_to_friend_request(uuid, boolean) to authenticated;
