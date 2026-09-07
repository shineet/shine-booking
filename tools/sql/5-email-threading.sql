-- One column, so a client's emails arrive as one conversation.
--
-- Mail clients thread on the RFC 5322 headers In-Reply-To and References, which
-- carry the Message-ID of the mail being answered. Nothing read that header on
-- the way in or wrote it on the way out, so every reply arrived in the client's
-- inbox as an unrelated new message. Gmail hides most of it by grouping on
-- subject; Outlook does not, and Outlook is what corporate planners use.
--
-- This is where their Message-ID is kept. It is written when their email
-- arrives and quoted when a reply goes out.
--
-- Safe to run more than once. It adds a nullable column and changes no existing
-- row: every message already stored simply has no id, which is correct -- we
-- never had it. Those older conversations will not thread; ones from here on
-- will.

alter table messages
  add column if not exists email_message_id text;

-- The lookup is always "the newest inbound email from this client that has an
-- id", so it is worth an index rather than a scan of every message ever sent.
create index if not exists messages_thread_lookup
  on messages (client_id, created_at desc)
  where channel = 'email' and direction = 'inbound' and email_message_id is not null;

-- Confirm it landed. Expect one row: email_message_id, text, YES (nullable).
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_name = 'messages' and column_name = 'email_message_id';
