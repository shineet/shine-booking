#!/usr/bin/env python3
"""
Two-way sync between the shared Apple "Family" note and Supabase.

PULL  note -> family_events        so the gig dashboard can warn about clashes
PUSH  bookings -> note             so a booked gig appears on the family list

Runs on Shine's Mac because Apple Notes has no API and Vercel cannot reach
it. Intended to be run unattended by launchd, so unlike family_note.py's CLI
this does real work by default; pass --dry-run to see what it would do.

Safety on the push side, since the note is shared with Shine's wife:
  * the note is backed up before every write (family_note.backup)
  * only whole lines are inserted, in date order; nothing is edited or moved
  * family_note_writes records what has been written, so a re-run is a no-op
  * only future gigs are written -- a completed gig in the past is noise

Credentials come from a .env beside this file (gitignored):
    SUPABASE_URL=https://xxxx.supabase.co
    SUPABASE_SECRET_KEY=...
"""

# Deferred annotation evaluation. launchd runs this with /usr/bin/python3,
# which is 3.9 on this Mac, and "dt.date | None" is a runtime TypeError
# there without this. py_compile does not catch it -- the syntax is
# valid, it fails when the def is evaluated.
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

import family_note

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(HERE, ".env")

# Anything at or past "booked" is a real commitment worth putting on the
# family list. Mirrors STATUS_RANK in api/reply.js -- keep the two in step.
BOOKED_STATUSES = [
    "booked", "intake_sent", "intake_completed",
    "contract_sent", "contract_signed", "completed",
]


def load_env() -> dict:
    if not os.path.exists(ENV_PATH):
        sys.exit(
            f"Missing {ENV_PATH}\n"
            "Create it with SUPABASE_URL and SUPABASE_SECRET_KEY "
            "(copy from Vercel -> shine-booking -> Environment Variables)."
        )
    env = {}
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    for key in ("SUPABASE_URL", "SUPABASE_SECRET_KEY"):
        if not env.get(key):
            sys.exit(f"{ENV_PATH} is missing {key}")
    return env


def supabase(env, method, path, body=None, prefer=None):
    """Minimal PostgREST client -- no dependencies, this runs on a bare Mac."""
    # Supabase's dashboard shows the API URL WITH "/rest/v1/" already on it
    # (Settings -> Data API), while the SUPABASE_URL convention this project
    # uses elsewhere is the bare origin. Accept either rather than produce a
    # baffling /rest/v1/rest/v1/ 404 depending on which one got pasted.
    base = env["SUPABASE_URL"].strip().rstrip("/")
    if base.endswith("/rest/v1"):
        base = base[: -len("/rest/v1")]
    url = base + "/rest/v1/" + path.lstrip("/")
    headers = {
        "apikey": env["SUPABASE_SECRET_KEY"],
        "Authorization": f"Bearer {env['SUPABASE_SECRET_KEY']}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:400]
        raise RuntimeError(f"{method} {path} -> {e.code}: {detail}") from None


# ---------------------------------------------------------------- pull

def pull(env, note_text, dry_run: bool) -> int:
    """Note -> family_events. Returns the number of events published."""
    events = family_note.parse_events(note_text)
    if not events:
        # Refuse to wipe the table over an empty parse. An empty result is far
        # more likely to mean the note failed to read, or its format changed,
        # than that the family genuinely has nothing on. Leaving yesterday's
        # warnings up is strictly safer than showing none.
        print("PULL: parsed 0 events -- leaving existing rows untouched")
        return 0

    batch = str(uuid.uuid4())
    rows = [{
        "event_date": e["date"].isoformat(),
        "title": e["title"],
        "raw_line": e["raw"],
        "sync_batch": batch,
    } for e in events]

    if dry_run:
        print(f"PULL: would publish {len(rows)} events as batch {batch[:8]}")
        for e in events:
            print(f"       {e['date']}  {e['title']}")
        return len(rows)

    # Insert the new batch BEFORE removing the old one. If this dies in
    # between, the dashboard briefly sees duplicates rather than an empty
    # calendar -- a duplicate warning is harmless, a missing one is not.
    supabase(env, "POST", "family_events", rows, prefer="return=minimal")
    supabase(env, "DELETE", f"family_events?sync_batch=neq.{batch}")
    print(f"PULL: published {len(rows)} events (batch {batch[:8]})")
    return len(rows)


# ---------------------------------------------------------------- push

def describe(booking: dict) -> str:
    """
    The line that lands in the family note.

    Deliberately terse, matching what is already in there ("Sep 4th Magic
    Show", "Aug 31st Magic show at 7 pm"). Shine's wife reads this note, so
    it says what the family needs -- that he is working -- and not the client
    or the fee. Set FAMILY_NOTE_INCLUDE_VENUE=1 in .env to append the venue.
    """
    label = "Magic Show"
    time = pretty_time(booking.get("start_time"))
    if time:
        label += f" at {time}"
    if os.environ.get("FAMILY_NOTE_INCLUDE_VENUE") == "1":
        venue = (booking.get("venue_address") or "").strip()
        if venue:
            label += f" ({venue})"
    return label


def pretty_time(value) -> str:
    """
    "19:00:00" -> "7 pm", "19:30:00" -> "7:30 pm".

    The note is written by hand in plain language ("at 7 pm"), so a raw SQL
    time would look out of place. Anything that does not parse is passed
    through untouched rather than dropped -- better an odd-looking line than
    a silently missing time.
    """
    raw = str(value or "").strip()
    if not raw:
        return ""
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            t = dt.datetime.strptime(raw, fmt).time()
        except ValueError:
            continue
        hour = t.hour % 12 or 12
        ampm = "am" if t.hour < 12 else "pm"
        return f"{hour}:{t.minute:02d} {ampm}" if t.minute else f"{hour} {ampm}"
    return raw


def push(env, note_text, dry_run: bool) -> str:
    """
    Bookings -> note. Returns the note text after any insertions, so the
    caller can pull from the updated version in the same run.
    """
    status_filter = ",".join(BOOKED_STATUSES)
    today = dt.date.today().isoformat()
    bookings = supabase(
        env, "GET",
        f"bookings?select=id,event_date,start_time,venue_address,status,client_name,event_title"
        f"&status=in.({status_filter})"
        f"&event_date=gte.{today}"
        f"&order=event_date.asc",
    ) or []

    if not bookings:
        print("PUSH: no upcoming booked gigs")
        return note_text

    written = supabase(env, "GET", "family_note_writes?select=booking_id") or []
    already = {str(r["booking_id"]) for r in written}

    pending = [b for b in bookings if str(b["id"]) not in already]
    if not pending:
        print(f"PUSH: {len(bookings)} upcoming gig(s), all already in the note")
        return note_text

    for b in pending:
        date = dt.date.fromisoformat(b["event_date"])

        # Match on the DATE, not the wording. Shine writes these by hand in his
        # own phrasing ("Magic show at 7 pm") while this would generate "Magic
        # Show", and the first dry run showed an exact-string check would have
        # added a second line for two gigs already in the note. His line always
        # wins -- it is recorded as-is and never edited or replaced.
        existing = family_note.gig_already_noted(note_text, date)
        if existing:
            # The one permitted edit to an existing line: fill in a start time
            # the note is missing and the booking knows. Wording, position and
            # every other line stay exactly as written.
            time = pretty_time(b.get("start_time"))
            if time and not family_note.has_time(existing):
                note_text_after, line = family_note.append_time(note_text, existing, time)
                if dry_run:
                    print(f"PUSH: would add time to: {existing}  ->  {line}")
                else:
                    path = family_note.backup(note_text)
                    family_note.write_note(note_text_after)
                    print(f"PUSH: added time: {line}  (backup {os.path.basename(path)})")
                note_text = note_text_after
            else:
                print(f"PUSH: already in the note, recording only: {existing}")
                line = existing
        else:
            line = describe(b)
            note_text_after, line, _ = family_note.insert_line(note_text, date, line)
            if dry_run:
                print(f"PUSH: would insert: {line}")
            else:
                path = family_note.backup(note_text)
                family_note.write_note(note_text_after)
                print(f"PUSH: inserted: {line}  (backup {os.path.basename(path)})")
            note_text = note_text_after

        if not dry_run:
            supabase(env, "POST", "family_note_writes", [{
                "booking_id": str(b["id"]),
                "event_date": b["event_date"],
                "line": line,
            }], prefer="return=minimal,resolution=merge-duplicates")

    return note_text


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would change, write nothing")
    ap.add_argument("--pull-only", action="store_true")
    ap.add_argument("--push-only", action="store_true")
    args = ap.parse_args()

    env = load_env()
    for k, v in env.items():
        os.environ.setdefault(k, v)

    stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"=== family note sync {stamp}{' (dry run)' if args.dry_run else ''} ===")

    note_text = family_note.read_note()

    # Push first, then pull: a gig written into the note this run should be
    # reflected in family_events immediately rather than a cycle later.
    if not args.pull_only:
        note_text = push(env, note_text, args.dry_run)
    if not args.push_only:
        pull(env, note_text, args.dry_run)

    return 0


if __name__ == "__main__":
    sys.exit(main())
