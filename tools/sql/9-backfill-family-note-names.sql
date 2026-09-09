-- Put client names (and times) on the family-note lines written before b02bc19.
--
-- Older lines read just "Sep 11th Magic show", so a note with three of them
-- told the household there were three shows and nothing else. New lines carry
-- the name; this brings the existing ones up to date, once.
--
-- SAFETY, and it is the point of the whole thing: only a line that is EXACTLY
-- what the app used to emit is touched --
--
--     Sep 11th Magic show
--     Sep 11th Magic show at 6 PM
--
-- Anything reworded by hand is left alone, because this note is a shared
-- document Nadia edits directly and a program must not overwrite her wording.
-- The same rule the app itself now follows.
--
-- RUN SECTION 1 FIRST and read it.

-- ── The two helpers, matching lib/family-note-server.js exactly ────────────

create or replace function fn_human_date(d date) returns text language sql immutable as $$
  select to_char(d, 'Mon') || ' ' || extract(day from d)::int ||
         case when extract(day from d)::int % 100 between 11 and 13 then 'th'
              when extract(day from d)::int % 10 = 1 then 'st'
              when extract(day from d)::int % 10 = 2 then 'nd'
              when extract(day from d)::int % 10 = 3 then 'rd'
              else 'th' end;
$$;

create or replace function fn_pretty_time(t text) returns text language sql immutable as $$
  select case
    when t is null or btrim(t) = '' then ''
    when btrim(t) !~ '^\d{1,2}:\d{2}' then btrim(t)
    else (
      with p as (select (split_part(btrim(t), ':', 1))::int as h,
                        substr(split_part(btrim(t), ':', 2), 1, 2) as mi)
      select case when h >= 12 then
               (case when h % 12 = 0 then 12 else h % 12 end)::text
             else
               (case when h % 12 = 0 then 12 else h % 12 end)::text
             end
             || (case when mi = '00' then '' else ':' || mi end)
             || (case when h >= 12 then ' PM' else ' AM' end)
      from p)
  end;
$$;

-- ── 1. What would change. Read only. ──────────────────────────────────────

with note as (select content from family_note where id = 1),
     g as (
       select fn_human_date(b.event_date)                          as human,
              coalesce(b.client_name, '')                          as who,
              fn_pretty_time(b.start_time)                         as at_time
         from bookings b
        where b.event_date is not null
          and coalesce(b.client_name, '') <> ''
          and b.status not in ('lost', 'cancelled')
     ),
     candidate as (
       select g.*,
              g.human || ' Magic show'                                        as old_bare,
              g.human || ' Magic show at ' || g.at_time                       as old_timed,
              g.human || ' Magic show for ' || g.who
                || case when g.at_time = '' then '' else ' at ' || g.at_time end as new_line
         from g
     ),
     lines as (
       select trim(l) as line from note, unnest(string_to_array(note.content, E'\n')) as l
     )
select l.line as currently, c.new_line as becomes
  from lines l
  join candidate c
    on lower(l.line) = lower(c.old_bare)
    or (c.at_time <> '' and lower(l.line) = lower(c.old_timed))
 order by 1;

-- ── 2. Apply it. Only after reading section 1. ────────────────────────────
--
-- Rebuilds the note line by line, replacing only lines that match one of the
-- two old forms EXACTLY. Deliberately not a regexp_replace over the whole
-- text: an expression that is a little bit wrong there does not fail, it
-- quietly leaves half a time behind in a document the household reads.
--
-- Safe to run twice: a line already carrying a name matches nothing.

-- do $$
-- declare
--   src   text;
--   out_t text := '';
--   ln    text;
--   hit   text;
--   first boolean := true;
-- begin
--   select content into src from family_note where id = 1;
--   foreach ln in array string_to_array(src, E'\n') loop
--     select c.new_line into hit
--       from (
--         select fn_human_date(b.event_date) as human,
--                coalesce(b.client_name, '') as who,
--                fn_pretty_time(b.start_time) as at_time,
--                fn_human_date(b.event_date) || ' Magic show for ' || coalesce(b.client_name, '')
--                  || case when fn_pretty_time(b.start_time) = '' then ''
--                          else ' at ' || fn_pretty_time(b.start_time) end as new_line
--           from bookings b
--          where b.event_date is not null
--            and coalesce(b.client_name, '') <> ''
--            and b.status not in ('lost', 'cancelled')
--       ) c
--      where lower(btrim(ln)) = lower(c.human || ' Magic show')
--         or (c.at_time <> '' and lower(btrim(ln)) = lower(c.human || ' Magic show at ' || c.at_time))
--      limit 1;
--
--     out_t := out_t || case when first then '' else E'\n' end || coalesce(hit, ln);
--     hit := null;
--     first := false;
--   end loop;
--   update family_note set content = out_t where id = 1;
-- end $$;

-- Read it back and check it looks right.
-- select content from family_note where id = 1;

-- ── 3. Tidy up. The helpers were only needed for this. ────────────────────
-- drop function if exists fn_human_date(date);
-- drop function if exists fn_pretty_time(text);
