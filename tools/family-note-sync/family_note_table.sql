-- The shared family list, now edited directly on family.html instead of Apple
-- Notes. A single row (id = 1) holding the whole note as plain text; the app
-- parses dates out of it in the browser.
create table if not exists family_note (
  id          int         primary key,
  content     text        not null default '',
  updated_at  timestamptz not null default now()
);

-- Same posture as the rest of the project: RLS on, no public policies. The
-- API proxy uses the service key (which bypasses RLS) and gates access with
-- the dashboard password or the family PIN.
alter table family_note enable row level security;
