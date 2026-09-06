-- Sign-ups from the Agni beta page (agni.html), collected at a dinner table
-- with a QR code rather than by typing addresses into App Store Connect.
--
-- RLS on with no policies, deliberately. Nothing reaches this table except
-- through the server proxy in api/get-booking.js using the service key, which
-- is the same arrangement every other table here uses. The page is public and
-- unauthenticated, so the browser must never hold a key that can read it back:
-- these are other people's email addresses.
create table if not exists agni_testers (
  id          bigint generated always as identity primary key,
  name        text not null,
  email       text not null unique,
  -- TestFlight is iOS only. Asked so an Android friend is told that on the
  -- spot instead of waiting for an invite that can never arrive.
  device      text,
  invited     boolean not null default false,
  created_at  timestamptz not null default now()
);

alter table agni_testers enable row level security;

-- Newest first, which is the order they will be read in.
create index if not exists agni_testers_created_idx on agni_testers (created_at desc);
