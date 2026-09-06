-- Shared expenses for the trip planner. Run once in the same Supabase project.
--
-- Money is stored in CENTS as an integer. Splitting 100.00 three ways in
-- floating point gives three numbers that do not add back up to 100.00, and a
-- settlement built on that never reaches zero: somebody is left owing a
-- fraction of a cent forever.

create table if not exists trip_people (
  id          uuid primary key default gen_random_uuid(),
  trip        text        not null default 'spain',
  -- A "person" is a couple here. Four couples settle as four, and the
  -- arithmetic does not care which it is.
  name        text        not null default '',
  -- When they are actually on the trip. Null means the whole thing. This is
  -- what stops a Madrid dinner being split with somebody who is still at home.
  from_date   date,
  to_date     date,
  sort_index  int         not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists trip_expenses (
  id           uuid primary key default gen_random_uuid(),
  trip         text        not null default 'spain',
  spent_on     date,
  description  text        not null default '',
  amount_cents integer     not null default 0,
  -- What was actually paid, in the currency it was actually paid in. Converting
  -- on the way IN would lose what the receipt said, and then nobody can check
  -- it against a card statement.
  currency     text        not null default 'EUR',
  paid_by      uuid        references trip_people(id) on delete cascade,
  shared_with  uuid[]      not null default '{}',
  author       text        not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One agreed rate for the whole trip, not a live one.
--
-- Every card will apply its own rate on the day, so no single number is "true".
-- What matters between friends is that everyone is converted by the SAME
-- number, which is fair even when it is slightly wrong. 1.22 is what the
-- European Central Bank rate came to on the Iryo booking.
create table if not exists trip_config (
  trip        text primary key default 'spain',
  usd_per_eur numeric not null default 1.22,
  updated_at  timestamptz not null default now()
);

create index if not exists trip_people_trip_idx   on trip_people (trip, sort_index);
create index if not exists trip_expenses_trip_idx on trip_expenses (trip, spent_on);

alter table trip_people   enable row level security;
alter table trip_expenses enable row level security;
alter table trip_config   enable row level security;

insert into trip_config (trip) values ('spain') on conflict (trip) do nothing;

-- The four couples. Dev and Nithya are only there for the Barcelona end, so
-- expenses before the 13th will not offer to split with them.
insert into trip_people (trip, name, from_date, to_date, sort_index)
select * from (values
  ('spain', 'Shine & Nadia',   null::date,        null::date,        0),
  ('spain', 'Manoj & Kavitha', null::date,        null::date,        1),
  ('spain', 'Noumit & Meher',  null::date,        null::date,        2),
  ('spain', 'Dev & Nithya',    date '2026-10-13', date '2026-10-15', 3)
) as seed(trip, name, from_date, to_date, sort_index)
where not exists (select 1 from trip_people where trip = 'spain');
