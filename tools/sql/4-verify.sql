-- Read only. Confirms the enforcement is actually in place.
--
-- "Success. No rows returned" from the install only means the statements parsed
-- and ran. This is what proves the triggers exist and are enabled.
--
-- Expect exactly 4 rows, all with enabled = 'O' (the default: fires on normal
-- writes). Anything other than 4 means part of the install did not land.

select tgname                              as trigger_name,
       tgrelid::regclass                   as on_table,
       proname                             as runs_function,
       case tgenabled
         when 'O' then 'enabled'
         when 'D' then 'DISABLED'
         else tgenabled::text
       end                                 as state
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
 where not t.tgisinternal
   and tgname in ('clients_date_to_bookings', 'bookings_date_to_client',
                  'clients_fee_to_bookings',  'bookings_fee_to_client')
 order by on_table, trigger_name;
