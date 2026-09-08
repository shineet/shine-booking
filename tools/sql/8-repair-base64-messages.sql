-- Decode the messages that were stored as base64 before the fix.
--
-- api/email-reply.js could not see a Content-Transfer-Encoding header that was
-- listed above Content-Type, so those emails were saved as the literal base64
-- string. Krista's reply was one. The code is fixed from 83de302 onward; this
-- repairs what is already in the table.
--
-- Postgres does the decoding, so nothing is retyped from a screenshot and
-- nothing can be transcribed wrongly.
--
-- RUN SECTION 1 FIRST and read it. Section 2 rewrites message content, and a
-- client's own words are the one thing here that cannot be regenerated.

-- ── 1. What would change. Read only. ───────────────────────────────────────
--
-- The guard is deliberately narrow: an inbound email whose content is nothing
-- but base64 characters and padding. Ordinary prose contains spaces and
-- punctuation and cannot match.

select id,
       created_at::date                  as received,
       left(content, 40)                 as stored_now,
       left(convert_from(decode(regexp_replace(content, '\s', '', 'g'), 'base64'), 'UTF8'), 80)
                                         as would_become
  from messages
 where direction = 'inbound'
   and channel = 'email'
   and length(regexp_replace(content, '\s', '', 'g')) >= 24
   and regexp_replace(content, '\s', '', 'g') ~ '^[A-Za-z0-9+/]+={0,2}$'
 order by created_at desc;

-- ── 2. Fix them. Only after reading section 1. ─────────────────────────────
--
-- Same guard, so it can only touch the rows just listed. Safe to run twice:
-- once decoded, the content is prose and no longer matches.

-- update messages
--    set content = convert_from(decode(regexp_replace(content, '\s', '', 'g'), 'base64'), 'UTF8')
--  where direction = 'inbound'
--    and channel = 'email'
--    and length(regexp_replace(content, '\s', '', 'g')) >= 24
--    and regexp_replace(content, '\s', '', 'g') ~ '^[A-Za-z0-9+/]+={0,2}$';
