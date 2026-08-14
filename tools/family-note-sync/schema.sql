-- Family note sync: events parsed out of the shared Apple Note, plus a
-- record of which booked gigs have already been written back into it.

-- 1. Events pulled FROM the note, so the dashboard can flag clashes.
create table if not exists family_events (
  id          bigserial primary key,
  event_date  date        not null,
  title       text        not null,
  raw_line    text        not null,
  -- Each sync run stamps its own batch id. The agent inserts the new batch
  -- first and only then deletes the previous one, so a run that dies
  -- halfway leaves duplicate warnings rather than an empty table. Harmless
  -- either way, but never a window where the dashboard shows no clashes
  -- when clashes exist.
  sync_batch  uuid        not null,
  synced_at   timestamptz not null default now()
);

create index if not exists family_events_date_idx  on family_events (event_date);
create index if not exists family_events_batch_idx on family_events (sync_batch);

-- 2. Gigs already written INTO the note, so re-running never duplicates a line.
create table if not exists family_note_writes (
  -- text rather than uuid deliberately: this works whether bookings.id is a
  -- uuid or a bigint, and avoids a foreign key that would block the agent if
  -- a booking were ever deleted.
  booking_id  text        primary key,
  event_date  date        not null,
  line        text        not null,
  written_at  timestamptz not null default now()
);

-- Match the rest of this project: RLS on, no public policies. The agent and
-- the API both use the service key, which bypasses RLS. Nothing reaches these
-- tables from a browser.
alter table family_events      enable row level security;
alter table family_note_writes enable row level security;
