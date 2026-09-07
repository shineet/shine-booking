-- Make the duplicate date and fee columns physically unable to disagree.
--
-- WHY THIS EXISTS
--
-- A gig's date lives in two columns: clients.event_date (written when the lead
-- is created, before any gig exists) and bookings.event_date (the gig itself).
-- The fee is the same story: clients.selected_price and bookings.fee.
--
-- The app now has one writer for each and writes both copies, so through the
-- app they cannot drift. But that is a discipline in application code, and a
-- discipline only holds until someone writes a fourth path -- a new endpoint, a
-- hand-run PATCH, a feature added a year from now. Bella and Maggie were both
-- this bug: two copies of one number, and no rule about which was true.
--
-- These triggers move the rule into the database, where every writer meets it.
--
-- WHAT THEY DO NOT DO
--
-- They do not touch completed, lost or cancelled gigs. A finished gig's date
-- and fee are history and must not be rewritten by someone tidying up a lead a
-- year later.
--
-- They never write a NULL over a real value. Filling a blank is allowed in both
-- directions -- that is the Bella case, a gig created with no date and a lead
-- that has since got one -- but clearing a value is always a deliberate act and
-- never propagates.
--
-- ORDER: run section 1 first and READ THE RESULT. If it returns rows, decide
-- which copy is right for each before installing anything, because the first
-- write after these triggers exist will propagate whatever is there.

-- ============================================================
-- 1. READ ONLY. Anything that already disagrees.
-- ============================================================

select c.id,
       c.name,
       c.event_date      as lead_says,
       b.event_date      as gig_says,
       c.selected_price  as lead_fee,
       b.fee             as gig_fee,
       b.status
  from clients c
  join bookings b on b.client_id = c.id
 where b.status not in ('completed', 'lost', 'cancelled')
   and (
        (c.event_date is not null and b.event_date is not null
         and c.event_date is distinct from b.event_date)
     or (c.selected_price is not null and b.fee is not null
         and c.selected_price is distinct from b.fee)
       )
 order by b.event_date nulls last;

-- ============================================================
-- 2. The date, both directions.
-- ============================================================

create or replace function sync_event_date_from_client()
returns trigger language plpgsql as $$
begin
  if new.event_date is not null then
    update bookings
       set event_date = new.event_date
     where client_id = new.id
       and status not in ('completed', 'lost', 'cancelled')
       and event_date is distinct from new.event_date;
  end if;
  return new;
end $$;

create or replace function sync_event_date_to_client()
returns trigger language plpgsql as $$
begin
  if new.event_date is not null
     and new.status not in ('completed', 'lost', 'cancelled')
     and new.client_id is not null then
    update clients
       set event_date = new.event_date
     where id = new.client_id
       and event_date is distinct from new.event_date;
  end if;
  return new;
end $$;

-- The two triggers call each other, and terminate because each UPDATE carries
-- "is distinct from": the return trip finds the value already equal, matches no
-- rows, and fires nothing further. The WHEN clause stops a no-op update from
-- starting the cycle at all.

drop trigger if exists clients_date_to_bookings on clients;
create trigger clients_date_to_bookings
  after update of event_date on clients
  for each row
  when (old.event_date is distinct from new.event_date)
  execute function sync_event_date_from_client();

drop trigger if exists bookings_date_to_client on bookings;
create trigger bookings_date_to_client
  after update of event_date on bookings
  for each row
  when (old.event_date is distinct from new.event_date)
  execute function sync_event_date_to_client();

-- ============================================================
-- 3. The fee, both directions.
--
-- clients.selected_price is already treated as a mirror of the gig fee rather
-- than as a separate number: api/send-contract.js writes it with the comment
-- "so dashboard card shows fee". This makes that intent enforced instead of
-- remembered.
-- ============================================================

create or replace function sync_fee_from_client()
returns trigger language plpgsql as $$
begin
  if new.selected_price is not null then
    update bookings
       set fee = new.selected_price
     where client_id = new.id
       and status not in ('completed', 'lost', 'cancelled')
       and fee is distinct from new.selected_price;
  end if;
  return new;
end $$;

create or replace function sync_fee_to_client()
returns trigger language plpgsql as $$
begin
  if new.fee is not null
     and new.status not in ('completed', 'lost', 'cancelled')
     and new.client_id is not null then
    update clients
       set selected_price = new.fee
     where id = new.client_id
       and selected_price is distinct from new.fee;
  end if;
  return new;
end $$;

drop trigger if exists clients_fee_to_bookings on clients;
create trigger clients_fee_to_bookings
  after update of selected_price on clients
  for each row
  when (old.selected_price is distinct from new.selected_price)
  execute function sync_fee_from_client();

drop trigger if exists bookings_fee_to_client on bookings;
create trigger bookings_fee_to_client
  after update of fee on bookings
  for each row
  when (old.fee is distinct from new.fee)
  execute function sync_fee_to_client();

-- ============================================================
-- 4. Undo, if any of this ever gets in the way.
-- ============================================================
--
-- drop trigger if exists clients_date_to_bookings on clients;
-- drop trigger if exists bookings_date_to_client  on bookings;
-- drop trigger if exists clients_fee_to_bookings  on clients;
-- drop trigger if exists bookings_fee_to_client   on bookings;
-- drop function if exists sync_event_date_from_client();
-- drop function if exists sync_event_date_to_client();
-- drop function if exists sync_fee_from_client();
-- drop function if exists sync_fee_to_client();
