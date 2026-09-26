-- 0880: an idempotent child refresh, so a lost response does not unpair a tablet (BUG-244).
--
-- Rotation treats any re-presentation of a used refresh token as theft and revokes the session
-- (spec P3). That is right for a replay, and wrong for the tablet's own retry after its response
-- was lost on the way back: one dropped HTTP response unpaired a child's device and the parent had
-- to mint a new pairing code.
--
-- A time window cannot separate the two cases — inside it, a replayer looks exactly like the
-- rightful holder — so the request carries an id instead. The tablet generates it once per refresh
-- and keeps it across its own retries of that refresh; the server records the id that consumed each
-- token. A used token presented again WITH the id that consumed it is the rightful holder finishing
-- its attempt; with any other id, or none, it is still theft.
--
-- Nothing is required of a client that does not send an id: those requests keep today's behaviour
-- exactly, so an installed app is never worse off than before.
alter table private.child_refresh_tokens
  add column if not exists used_request_id uuid;

comment on column private.child_refresh_tokens.used_request_id is
  'The client refresh-request id that consumed this token (BUG-244). Null for a token rotated by a '
  'client that sent no id, and for a token that has not been used. Only a re-presentation carrying '
  'this exact id is treated as the rightful holder retrying; anything else stays refresh-token theft.';

-- The recovery path looks up "is the replacement of this token still unclaimed?" by id, which the
-- primary key already serves. This index serves the other direction — every token a given request
-- consumed — which the audit of a suspected replay needs.
create index if not exists child_refresh_tokens_used_request
  on private.child_refresh_tokens (used_request_id)
  where used_request_id is not null;
