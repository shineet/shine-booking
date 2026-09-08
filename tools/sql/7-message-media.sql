-- Somewhere to keep the photos and video clients send.
--
-- Until now nothing stored the bytes: a picture message was named in the
-- conversation and forwarded to Shine's phone, and that forward was the only
-- place it existed. This gives the app its own copy so the picture can be
-- looked at in the thread, months later, next to the conversation it belongs
-- to.
--
-- Safe to run more than once, and it changes no existing row.

-- ── The bucket ─────────────────────────────────────────────────────────────
--
-- PRIVATE. These are photographs of other people's weddings, birthday parties
-- and children, sent to a performer in confidence. A public bucket would make
-- every one of them readable by anyone who guessed a URL, for ever. The app
-- reads them through short-lived signed links instead.

insert into storage.buckets (id, name, public, file_size_limit)
values ('message-media', 'message-media', false, 52428800)   -- 50 MB a file
on conflict (id) do nothing;

-- No storage policies are created on purpose. RLS is on and nothing can read
-- the bucket except the server's service key, which is the same arrangement
-- every other table here uses: the browser and the app never touch the data
-- directly, they go through the API.

-- ── Where the files are recorded ───────────────────────────────────────────
--
-- jsonb rather than a table: it is always read with its message and never
-- queried on its own. Shape is
--   [{"path": "...", "type": "image/jpeg", "bytes": 812345}]
-- and a file too large to keep is recorded with "stored": false, so the
-- conversation can still say something arrived rather than staying silent
-- about it, which is the failure this whole exercise is about.

alter table messages
  add column if not exists media jsonb;

-- ── Confirm ────────────────────────────────────────────────────────────────
-- Expect two rows: the bucket, and the column.

select 'bucket' as what, id as name, public::text as detail
  from storage.buckets where id = 'message-media'
union all
select 'column', column_name, data_type
  from information_schema.columns
 where table_name = 'messages' and column_name = 'media';
