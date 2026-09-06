-- Shared expenses for the trip planner. Run in the same Supabase project.
--
-- Money is stored in CENTS as an integer. Splitting 100.00 three ways in
-- floating point gives three numbers that do not add back up to 100.00, and a
-- settlement built on that never reaches zero: somebody is left owing a
-- fraction of a cent forever.

create table if not exists trip_people (
  id          uuid primary key default gen_random_uuid(),
  trip        text        not null default 'spain',
  -- A "person" can be a couple. Eight people travelling as four couples settle
  -- as four, and the arithmetic does not care which it is.
  name        text        not null default '',
  sort_index  int         not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists trip_expenses (
  id           uuid primary key default gen_random_uuid(),
  trip         text        not null default 'spain',
  spent_on     date,
  description  text        not null default '',
  amount_cents integer     not null default 0,
  paid_by      uuid        references trip_people(id) on delete cascade,
  -- Who it splits between. Not everyone comes to every dinner.
  shared_with  uuid[]      not null default '{}',
  author       text        not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists trip_people_trip_idx   on trip_people (trip, sort_index);
create index if not exists trip_expenses_trip_idx on trip_expenses (trip, spent_on);

-- Same as the rest of this project: RLS on with no policies, so nothing reaches
-- these tables except through the server proxy using the service key.
alter table trip_people   enable row level security;
alter table trip_expenses enable row level security;
