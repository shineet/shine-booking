# Family note sync

Keeps the shared Apple Notes note **"Family"** and the booking app in step.

- **Pull** — parses the note into `family_events` so the gig dashboard can warn
  when a requested date already has something on it.
- **Push** — writes a booked gig back into the note, in date order, so Shine
  and his wife keep one list.

## Why it runs here and not on Vercel

Apple Notes has no API. It lives on this Mac and in iCloud, and nothing running
on Vercel can reach it — in either direction. So this agent is the bridge.

The consequence worth knowing: **the Mac has to be awake for a booked gig to
reach the note.** If it is closed for three days, the gig lands three days
later. Nothing is lost, it is just delayed.

## Setup

1. Run `schema.sql` in Supabase → SQL Editor (shine-booking project, *not*
   MyFinance).

2. Create `.env` beside these scripts — it is gitignored:

   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SECRET_KEY=...
   ```

   Both are in Vercel → shine-booking → Settings → Environment Variables.

3. Run it once by hand and approve the Automation prompt:

   ```
   python3 sync.py --dry-run
   ```

4. When the dry run looks right, schedule it:

   ```
   cp com.shine.familynotesync.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.shine.familynotesync.plist
   ```

## Day-to-day

```bash
python3 family_note.py list                        # everything in the note
python3 family_note.py check 2026-09-06            # clashes on a date
python3 family_note.py check 2026-09-03 --window 3 # ...and nearby days
python3 sync.py --dry-run                          # what would change
python3 sync.py                                    # do it
```

`--window` earns its keep: 3 Sept looks free on its own, but ±3 days shows
Onam prep either side of it.

## What it will not do

The note is shared, and losing it would be a real loss. So:

- every write takes a timestamped backup to `~/Documents/FamilyNoteBackups`
- lines are inserted whole, never reordered
- an existing line is edited in exactly one case, at Shine's request: a
  start time the booking knows and the note is missing gets appended to
  the end of that line. Wording and position are untouched.
- an identical line already present is left alone and simply recorded
- a parse returning **zero** events never wipes `family_events` — an empty
  result is far more likely to mean the read failed than that the family
  genuinely has nothing on
- only future gigs are written; a completed gig in the past is noise

## What the note entry says

Deliberately terse, matching the existing entries:

```
Sep 19th Magic Show
Sep 19th Magic Show at 7 pm     (when the booking has a time)
```

No client name and no fee — Shine's wife reads this note, and what the family
needs to know is that he is working. Set `FAMILY_NOTE_INCLUDE_VENUE=1` in
`.env` to append the venue.

## Troubleshooting

**Scheduled runs do nothing, manual runs work.** Automation permission. macOS
grants it per-app, and launchd is a different context to Terminal. Check
`sync.err.log`, then System Settings → Privacy & Security → Automation.

**A gig is missing from the note.** Check `family_note_writes` — if a row
exists, the agent believes it already wrote it. Delete that row to make it
try again.

**The note looks wrong.** Restore from `~/Documents/FamilyNoteBackups`; every
write leaves one, named by timestamp.
