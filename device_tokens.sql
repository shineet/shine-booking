-- Push device tokens for the ShineBooking native app.
-- Run once in the shine-booking Supabase project → SQL editor.
create table if not exists device_tokens (
  token       text primary key,
  platform    text default 'ios',
  environment text default 'sandbox',   -- matches the APNs key (Xcode dev builds = sandbox)
  created_at  timestamptz default now(),
  last_seen   timestamptz default now()
);
-- Only the server (service key) ever touches this table; RLS on, no public policies.
alter table device_tokens enable row level security;
