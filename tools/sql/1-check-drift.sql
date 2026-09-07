-- STEP 1. Read only. Nothing is changed by running this.
--
-- Lists every live gig whose date or fee disagrees with the lead's own copy of
-- it. An empty result is the good outcome and means step 2 is safe to run as is.
--
-- Rows that come back need a decision each, because the first write after the
-- triggers exist will propagate whichever value is sitting there.

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
