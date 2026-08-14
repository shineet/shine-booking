#!/usr/bin/env python3
"""
Read and write the shared "Family" note in Apple Notes.

Why this exists as a local script rather than part of the booking app:
Apple Notes has no API. It lives on this Mac and in iCloud, and nothing
running on Vercel can reach it. So both directions -- pulling family events
out so the dashboard can warn about clashes, and writing a booked gig back in
-- have to run here.

Safety stance, because this note is shared with Shine's wife and losing it
would be genuinely bad:
  * every write takes a timestamped backup first, no exceptions
  * writes are additive: a single line is inserted, existing lines are never
    edited or reordered
  * a line is only inserted if an identical one is not already present
  * --dry-run prints the exact resulting note and writes nothing

Usage:
    python3 family_note.py list                 # parsed events
    python3 family_note.py raw                  # the note as-is
    python3 family_note.py check 2026-09-06     # what's already on that date
    python3 family_note.py add 2026-09-19 "Magic Show at 7 pm" [--commit]
"""

import argparse
import datetime as dt
import os
import re
import subprocess
import sys

NOTE_NAME = "Family"
BACKUP_DIR = os.path.expanduser("~/Documents/FamilyNoteBackups")

# Matches an event line, which must START with a month for it to count.
# That anchoring is doing real work: the note also contains lines like
# "Move-In Appointment: Monday, August 17, 2026 02:00 PM" and "Name: Dia
# Shine", which mention a month or a date but are detail belonging to the
# event above them, not events in their own right. Anchoring to the start
# skips those without needing to special-case them.
MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}

# Real formats present in the note, all of which must parse:
#   "Aug 8th kavita house dinner"      month, space, day, ordinal suffix
#   "Aug 14 dias friends dinner"       no ordinal suffix
#   "Aug15th hair color appt at 3pm"   NO space between month and day
#   "august 17- move in day dia 2pm"   full month name, trailing dash
#   "Sept 5th dinner cooking..."       4-letter month abbreviation
EVENT_RE = re.compile(
    r"^\s*(?P<month>[A-Za-z]{3,9})\s*(?P<day>\d{1,2})(?:st|nd|rd|th)?\s*[-–:,]?\s*(?P<rest>.*)$"
)


def run_osascript(script: str) -> str:
    """Run AppleScript, returning stdout. Raises with stderr on failure."""
    proc = subprocess.run(
        ["osascript", "-"], input=script, capture_output=True, text=True
    )
    if proc.returncode != 0:
        raise RuntimeError(f"AppleScript failed: {proc.stderr.strip()}")
    return proc.stdout


def read_note() -> str:
    """Current plain-text body of the Family note."""
    # `plaintext` is preferred over `body` (which is HTML). Older macOS
    # versions lack it, hence the fallback.
    script = f'''
    tell application "Notes"
      set n to item 1 of (every note whose name is "{NOTE_NAME}")
      try
        return plaintext of n
      on error
        return body of n
      end try
    end tell
    '''
    return run_osascript(script)


def parse_events(text: str, today: dt.date | None = None) -> list[dict]:
    """
    Turn the note into dated events.

    Years are the interesting part: the note never writes one. It is kept in
    date order, so the year is inferred by walking top to bottom and rolling
    forward whenever a date goes backwards -- that is what a December to
    January boundary looks like in a list with no years on it.
    """
    today = today or dt.date.today()
    year = today.year
    prev: dt.date | None = None
    events: list[dict] = []

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        m = EVENT_RE.match(line)
        if not m:
            continue
        month = MONTHS.get(m.group("month").lower())
        if not month:
            continue  # a line starting with some other word
        day = int(m.group("day"))

        try:
            date = dt.date(year, month, day)
        except ValueError:
            continue  # e.g. Feb 30 -- skip rather than guess

        if prev and date < prev:
            year += 1
            try:
                date = dt.date(year, month, day)
            except ValueError:
                continue
        prev = date

        events.append({
            "date": date,
            "title": m.group("rest").strip(),
            "raw": line,
        })

    return events


def events_on(text: str, target: dt.date, window: int = 0) -> list[dict]:
    """Events on a date, optionally within +/- `window` days of it."""
    return [
        e for e in parse_events(text)
        if abs((e["date"] - target).days) <= window
    ]


def format_line(date: dt.date, title: str) -> str:
    """
    Render a new line in the same style as the existing ones, so the note
    still reads like one written by a person: "Sep 19th Magic Show at 7 pm".
    """
    suffix = "th"
    if date.day % 10 == 1 and date.day != 11:
        suffix = "st"
    elif date.day % 10 == 2 and date.day != 12:
        suffix = "nd"
    elif date.day % 10 == 3 and date.day != 13:
        suffix = "rd"
    month = date.strftime("%b")
    return f"{month} {date.day}{suffix} {title}".strip()


def insert_line(text: str, date: dt.date, title: str) -> tuple[str, str, bool]:
    """
    Insert one line in date order.

    Returns (new_text, the_line, changed). `changed` is False when an
    identical line is already present -- re-running the sync must never
    duplicate an entry.
    """
    line = format_line(date, title)

    existing = [l.strip() for l in text.splitlines()]
    if line in existing:
        return text, line, False

    lines = text.splitlines()
    events = parse_events(text)

    # Find the first existing event that falls after the new one and sit
    # above it. Matching on the raw line rather than an index keeps this
    # correct even though parse_events skips blanks and detail lines.
    insert_at = None
    for e in events:
        if e["date"] > date:
            for i, l in enumerate(lines):
                if l.strip() == e["raw"]:
                    insert_at = i
                    break
            if insert_at is not None:
                break

    if insert_at is None:
        # Later than everything already in the note -- append at the end,
        # keeping a blank line between entries as the note already does.
        new_lines = lines + ([""] if lines and lines[-1].strip() else []) + [line]
    else:
        new_lines = lines[:insert_at] + [line, ""] + lines[insert_at:]

    return "\n".join(new_lines), line, True


def backup(text: str) -> str:
    """Snapshot the note before any write. Returns the backup path."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    path = os.path.join(BACKUP_DIR, f"Family-{stamp}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def write_note(text: str) -> None:
    """
    Replace the note body. Only ever called with text that came from
    read_note() plus one inserted line, and only after backup().
    """
    # Notes stores HTML. Writing plain text with newlines collapses the
    # note into one line, so newlines are converted to <br> and the text is
    # HTML-escaped first.
    escaped = (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )
    html = escaped.replace("\n", "<br>")
    # AppleScript string literals escape backslash and double quote.
    literal = html.replace("\\", "\\\\").replace('"', '\\"')
    script = f'''
    tell application "Notes"
      set n to item 1 of (every note whose name is "{NOTE_NAME}")
      set body of n to "{literal}"
    end tell
    '''
    run_osascript(script)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("raw")
    sub.add_parser("list")

    c = sub.add_parser("check")
    c.add_argument("date")
    c.add_argument("--window", type=int, default=0,
                   help="also show events within N days either side")

    a = sub.add_parser("add")
    a.add_argument("date")
    a.add_argument("title")
    a.add_argument("--commit", action="store_true",
                   help="actually write. Without it, prints the result only.")

    args = ap.parse_args()
    text = read_note()

    if args.cmd == "raw":
        print(text)
        return 0

    if args.cmd == "list":
        for e in parse_events(text):
            print(f"{e['date']}  {e['title']}")
        return 0

    if args.cmd == "check":
        target = dt.date.fromisoformat(args.date)
        hits = events_on(text, target, args.window)
        if not hits:
            print(f"{target}: nothing in the family note")
            return 0
        print(f"{target}: {len(hits)} entr{'y' if len(hits)==1 else 'ies'}")
        for e in hits:
            when = "same day" if e["date"] == target else f"{(e['date']-target).days:+d}d"
            print(f"  [{when}] {e['date']}  {e['title']}")
        return 0

    if args.cmd == "add":
        target = dt.date.fromisoformat(args.date)
        new_text, line, changed = insert_line(text, target, args.title)
        if not changed:
            print(f"Already present, nothing to do: {line}")
            return 0
        if not args.commit:
            print(f"DRY RUN -- would insert: {line}\n")
            print("--- resulting note ---")
            print(new_text)
            print("\n(re-run with --commit to write)")
            return 0
        path = backup(text)
        write_note(new_text)
        print(f"Inserted: {line}")
        print(f"Backup:   {path}")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
