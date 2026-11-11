-- 0005_leaderboard_views
--
-- The landing page shows leaderboards to logged-out visitors, but `anon` has
-- no read access to profiles / matches / match_players and must not gain any.
-- So the aggregation lives in a SECURITY DEFINER function (which sees the base
-- tables) and the exposed object is a plain `security_invoker` view on top of
-- it. anon gets EXECUTE on the aggregate and nothing else. Using a bare
-- SECURITY DEFINER view instead would trip the security_definer_view lint.

create or replace function game.leaderboard_rows(p_since timestamptz default null)
returns table (
  rank        bigint,
  profile_id  uuid,
  handle      text,
  total_kills bigint,
  total_score bigint,
  matches     bigint,
  wins        bigint,
  best_wave   int,
  kd          numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    row_number() over (order by coalesce(sum(mp.score), 0) desc, p.handle asc) as rank,
    p.id     as profile_id,
    p.handle as handle,
    coalesce(sum(mp.kills), 0)::bigint as total_kills,
    coalesce(sum(mp.score), 0)::bigint as total_score,
    count(distinct mp.match_id)        as matches,
    count(*) filter (
      where m.winning_team is not null and mp.team = m.winning_team
    )                                  as wins,
    max(m.wave_reached)                as best_wave,
    round(
      coalesce(sum(mp.kills), 0)::numeric / greatest(coalesce(sum(mp.deaths), 0), 1),
      2
    )                                  as kd
  from game.profiles p
  join game.match_players mp on mp.profile_id = p.id and mp.is_bot = false
  join game.matches m        on m.id = mp.match_id
  where p_since is null or m.started_at >= p_since
  group by p.id, p.handle
  order by total_score desc, p.handle asc;
$$;

create or replace view game.leaderboard_alltime
with (security_invoker = true) as
  select * from game.leaderboard_rows(null);

create or replace view game.leaderboard_weekly
with (security_invoker = true) as
  select * from game.leaderboard_rows(now() - interval '7 days');

comment on view game.leaderboard_alltime is
  'All-time OVERRUN standings ordered by total score. Readable by anon.';
comment on view game.leaderboard_weekly is
  'Rolling 7-day OVERRUN standings ordered by total score. Readable by anon.';

grant execute on function game.leaderboard_rows(timestamptz) to anon, authenticated;
grant select on game.leaderboard_alltime to anon, authenticated;
grant select on game.leaderboard_weekly  to anon, authenticated;
