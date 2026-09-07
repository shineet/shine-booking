-- STEP 2. Makes the duplicate date and fee columns unable to disagree.
--
-- Run 1-check-drift.sql first and read what it returns.
--
-- WHY
--
-- A gig's date lives in two columns: clients.event_date, written when the lead
-- is created and before any gig exists, and bookings.event_date, the gig
-- itself. The fee is the same story: clients.selected_price and bookings.fee.
--
-- The app has one writer for each and writes both copies, so through the app
-- they cannot drift. But that is a discipline in application code, and a
-- discipline only holds until someone adds a fourth path. Bella and Maggie were
-- both this bug: two copies of one number and no rule about which was true.
-- This moves the rule into the database, where every writer meets it.
--
-- WHAT IT WILL NOT DO
--
-- It never touches a completed, lost or cancelled gig. A finished gig's date
-- and fee are history, and must not be rewritten by someone tidying up a lead a
-- year later.
--
-- It never writes a NULL over a real value. Filling a blank propagates in both
-- directions, which is the Bella case -- a gig created with no date and a lead
-- that has since got one. Clearing a value is always deliberate and stays put.

-- ============================================================
-- The date, both directions.
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
-- The fee, both directions.
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
