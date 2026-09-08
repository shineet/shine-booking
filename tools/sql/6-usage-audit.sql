-- Where the database size is actually going. Read only; changes nothing.
--
-- Run this alongside the Usage page in the Supabase dashboard. The Usage page
-- says WHICH limit is close (database size, egress, storage, compute); this says
-- WHAT is responsible, which is the half you cannot act on without.
--
-- Free-tier database allowance is 500 MB. Egress is a separate 5 GB and is not
-- visible from in here at all -- if that is the one running out, the cause is
-- how much the apps read, not how much is stored.

-- ── 1. The whole database, and the ten biggest tables ───────────────────────

select pg_size_pretty(pg_database_size(current_database())) as whole_database;

select
    relname                                          as table_name,
    to_char(n_live_tup, 'FM999,999,999')             as rows,
    pg_size_pretty(pg_total_relation_size(relid))    as total_size,
    pg_size_pretty(pg_relation_size(relid))          as just_the_rows,
    pg_size_pretty(pg_total_relation_size(relid)
                 - pg_relation_size(relid))          as indexes_and_toast
  from pg_stat_user_tables
 order by pg_total_relation_size(relid) desc
 limit 10;

-- ── 2. Is anything growing without a limit? ────────────────────────────────
--
-- messages is the table that grows forever by design: every text, every email,
-- every AI draft, kept for ever. If the database is filling up, it is almost
-- certainly this, and the fix is a retention rule rather than a bigger plan.

select
    date_trunc('month', created_at)::date            as month,
    count(*)                                         as messages,
    pg_size_pretty(sum(length(coalesce(content, '')))::bigint) as text_stored
  from messages
 group by 1
 order by 1 desc
 limit 12;

-- ── 3. Dead weight ─────────────────────────────────────────────────────────
--
-- Rows deleted but not yet vacuumed still occupy space. A large number here
-- means the reported size is worse than the real content, and a VACUUM FULL
-- would hand some of it back.

select
    relname                                   as table_name,
    n_live_tup                                as live_rows,
    n_dead_tup                                as dead_rows,
    last_autovacuum,
    last_autoanalyze
  from pg_stat_user_tables
 where n_dead_tup > 0
 order by n_dead_tup desc
 limit 10;
