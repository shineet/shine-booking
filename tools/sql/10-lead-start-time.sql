-- A start time on the lead, before there is a gig to hold one.
--
-- bookings.start_time has always existed; clients had nowhere to put a time, so
-- the New Lead form had a date and no hour. Christian Cline's email says the
-- show is around 8:30 PM, four months before there is a booking to write that
-- on, and it had to live in the notes where nothing reads it.
--
-- Same ownership rule as the date and the fee: the lead holds it until a gig
-- exists, then the gig owns it and the lead's copy follows. The triggers below
-- extend the pair already installed by 2-install-triggers.sql.
--
-- Safe to run more than once. Changes no existing row.

alter table clients
  add column if not exists start_time text;

-- ── Keep the two copies in step, exactly as date and fee already are ───────

create or replace function sync_start_time_from_client()
returns trigger language plpgsql as $$
begin
  if new.start_time is not null and new.start_time <> '' then
    update bookings
       set start_time = new.start_time
     where client_id = new.id
       and status not in ('completed', 'lost', 'cancelled')
       and coalesce(start_time, '') is distinct from new.start_time;
  end if;
  return new;
end $$;

create or replace function sync_start_time_to_client()
returns trigger language plpgsql as $$
begin
  if new.start_time is not null and new.start_time <> ''
     and new.status not in ('completed', 'lost', 'cancelled')
     and new.client_id is not null then
    update clients
       set start_time = new.start_time
     where id = new.client_id
       and coalesce(start_time, '') is distinct from new.start_time;
  end if;
  return new;
end $$;

drop trigger if exists clients_time_to_bookings on clients;
create trigger clients_time_to_bookings
  after update of start_time on clients
  for each row
  when (old.start_time is distinct from new.start_time)
  execute function sync_start_time_from_client();

drop trigger if exists bookings_time_to_client on bookings;
create trigger bookings_time_to_client
  after update of start_time on bookings
  for each row
  when (old.start_time is distinct from new.start_time)
  execute function sync_start_time_to_client();

-- ── Confirm ───────────────────────────────────────────────────────────────
-- Expect the column, then two rows, both enabled.

select 'column' as what, column_name as name, data_type as detail
  from information_schema.columns
 where table_name = 'clients' and column_name = 'start_time'
union all
select 'trigger', tgname, tgrelid::regclass::text
  from pg_trigger
 where not tgisinternal
   and tgname in ('clients_time_to_bookings', 'bookings_time_to_client');
