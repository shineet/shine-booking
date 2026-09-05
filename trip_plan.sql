-- Shared trip planner. Run once in the Supabase SQL editor for this project.
--
-- Two tables rather than one free-text note. Eight people editing one blob of
-- text is last-write-wins, and somebody's dinner booking quietly disappears.
-- A row per item means two people editing different things never collide.

create table if not exists trip_days (
  id          uuid primary key default gen_random_uuid(),
  trip        text        not null default 'spain',
  date        date        not null,
  city        text        not null default '',
  note        text        not null default '',
  sort_index  int         not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists trip_items (
  id          uuid primary key default gen_random_uuid(),
  trip        text        not null default 'spain',
  day_id      uuid        not null references trip_days(id) on delete cascade,
  at_time     text        not null default '',   -- '09:30', free text so "morning" works
  title       text        not null default '',
  detail      text        not null default '',
  place       text        not null default '',   -- opens in Maps on both phones
  category    text        not null default 'plan',
  booked      boolean     not null default false,
  author      text        not null default '',
  sort_index  int         not null default 0,
  updated_at  timestamptz not null default now()
);

create index if not exists trip_items_day_idx on trip_items (day_id, at_time, sort_index);
create index if not exists trip_days_trip_idx on trip_days (trip, sort_index);

-- Row level security ON with no policies, exactly like the rest of this
-- project: nothing reaches these tables except through the server proxy using
-- the service key, so the browser never holds anything that can read them.
alter table trip_days  enable row level security;
alter table trip_items enable row level security;

-- Six days to start. Dates are placeholders and can be changed in the page;
-- moving the first day shifts the rest and the items stay attached.
insert into trip_days (trip, date, city, sort_index)
select 'spain', d::date, c, i
from (values
  (0, date '2026-10-10', 'Madrid'),
  (1, date '2026-10-11', 'Madrid'),
  (2, date '2026-10-12', 'Madrid'),
  (3, date '2026-10-13', 'Barcelona'),
  (4, date '2026-10-14', 'Barcelona'),
  (5, date '2026-10-15', 'Barcelona')
) as seed(i, d, c)
where not exists (select 1 from trip_days where trip = 'spain');
