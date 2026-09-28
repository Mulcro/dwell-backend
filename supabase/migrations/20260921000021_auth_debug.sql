-- Temporary diagnostic for the YouVersion sign-in bring-up.
--
-- Their state replay keeps coming back "invalid or expired" and the docs have already
-- been wrong twice, so this records what the callback relay actually receives -- param
-- NAMES and a timestamp only, never values, which are live sign-in credentials.
--
-- Drop this table once sign-in works end to end.

create table auth_debug (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  leg text not null,
  param_names text[] not null
);

alter table auth_debug enable row level security;
-- No policies: only the service role reads or writes this.
