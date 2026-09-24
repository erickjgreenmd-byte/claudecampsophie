-- 0610_rate_limits.sql
-- Fixed-window rate-limit buckets shared by every API instance (PIN attempts, pairing-code and
-- promo-code guessing, redemption bursts). Private: only the API (service role) touches them.

create table private.rate_limit_buckets (
  bucket_key text primary key check (char_length(bucket_key) between 3 and 300),
  window_start timestamptz not null,
  hits integer not null check (hits >= 0),
  updated_at timestamptz not null default now()
);

-- Atomically counts a hit and reports whether it is within `p_limit` for the current window.
create or replace function app.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer, p_now timestamptz)
returns table (allowed boolean, hits integer, retry_after_seconds integer)
language plpgsql security definer
set search_path = ''
as $$
declare
  window_begin timestamptz := to_timestamp(floor(extract(epoch from p_now) / p_window_seconds) * p_window_seconds);
  current_hits integer;
begin
  insert into private.rate_limit_buckets as b (bucket_key, window_start, hits, updated_at)
    values (p_key, window_begin, 1, p_now)
    on conflict (bucket_key) do update
      set hits = case when b.window_start = excluded.window_start then b.hits + 1 else 1 end,
          window_start = excluded.window_start,
          updated_at = excluded.updated_at
    returning b.hits into current_hits;
  return query select
    current_hits <= p_limit,
    current_hits,
    greatest(0, ceil(extract(epoch from (window_begin + make_interval(secs => p_window_seconds) - p_now)))::integer);
end
$$;

revoke execute on function app.rate_limit_hit(text, integer, integer, timestamptz) from public, anon, authenticated, pl_child;
grant execute on function app.rate_limit_hit(text, integer, integer, timestamptz) to service_role;
