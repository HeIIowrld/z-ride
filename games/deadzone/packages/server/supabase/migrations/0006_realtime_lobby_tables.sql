-- 0006_realtime_lobby_tables
-- Realtime is enabled for the two lobby tables ONLY. matches and
-- match_players are intentionally left out: results are server-authoritative
-- and there is nothing for a client to subscribe to.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'game' and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table game.rooms;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'game' and tablename = 'room_members'
  ) then
    alter publication supabase_realtime add table game.room_members;
  end if;
end
$$;
