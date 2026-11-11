-- 0007_award_xp
-- Atomic XP/level application, called by the submit-match edge function with
-- the service role. Doing the increment in SQL avoids the read-modify-write
-- race two concurrent match submissions for the same player would otherwise
-- have. Level uses the canonical OVERRUN curve:
--   level = floor(log(xp / 260) / log(1.28)) + 1, clamped to >= 1
-- (log base is irrelevant to the ratio, so ln() is used).

create or replace function game.award_xp(p_awards jsonb)
returns table (profile_id uuid, xp int, level int)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with awards as (
    select
      (a->>'profile_id')::uuid       as pid,
      greatest((a->>'xp')::int, 0)   as amount
    from jsonb_array_elements(coalesce(p_awards, '[]'::jsonb)) a
    where a->>'profile_id' is not null
  ),
  merged as (
    -- One player can only appear once per match, but fold anyway so a
    -- malformed payload can never make the UPDATE match a row twice.
    select pid, sum(amount)::int as amount from awards group by pid
  )
  update game.profiles p
     set xp    = p.xp + m.amount,
         level = greatest(
           1,
           case
             when (p.xp + m.amount) < 260 then 1
             else floor(ln((p.xp + m.amount)::numeric / 260) / ln(1.28))::int + 1
           end
         )
    from merged m
   where p.id = m.pid
  returning p.id, p.xp, p.level;
end;
$$;

revoke all on function game.award_xp(jsonb) from public, anon, authenticated;
grant execute on function game.award_xp(jsonb) to service_role;
