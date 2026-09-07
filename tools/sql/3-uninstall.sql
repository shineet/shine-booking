-- Undo everything 2-install-triggers.sql did.
--
-- Safe to run at any time. It removes the enforcement only; no gig, lead, date
-- or fee is changed by running this. The app's own rule still applies after it,
-- because that lives in the app.

drop trigger if exists clients_date_to_bookings on clients;
drop trigger if exists bookings_date_to_client  on bookings;
drop trigger if exists clients_fee_to_bookings  on clients;
drop trigger if exists bookings_fee_to_client   on bookings;

drop function if exists sync_event_date_from_client();
drop function if exists sync_event_date_to_client();
drop function if exists sync_fee_from_client();
drop function if exists sync_fee_to_client();
