// Family note parsing, in the browser.
//
// The shared family list is now a plain-text note stored in the database and
// edited on family.html, exactly like the Apple Note it replaced. Both that
// page and the gig dashboard parse it with the rules here -- a faithful port
// of the old Mac agent's Python parser (tools/family-note-sync/family_note.py),
// so behaviour is identical, only now with no Mac and no sync lag.
(function () {
  const MONTHS = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9,
    oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };

  // Must START with a month; that anchoring skips detail lines like
  // "Move-In Appointment: Monday, August 17..." that mention a date but are
  // not events of their own.
  const EVENT_RE = /^\s*([A-Za-z]{3,9})\s*(\d{1,2})(?:st|nd|rd|th)?\s*[-–:,]?\s*(.*)$/;

  // Availability directives with no single date ("Shine not to travel the week
  // after 22nd"). Narrow on purpose so ordinary lines are left alone.
  const STANDING_KEYWORDS = [
    'travel', 'not available', 'unavailable', 'out of town', 'out-of-town',
    'away', 'blackout', 'no gig', 'no gigs', "don't book", 'do not book',
    'not to book', 'keep free', 'keep the week', 'no shows', 'no bookings',
  ];

  function pad(n) { return String(n).padStart(2, '0'); }

  // Years are never written in the note. It is kept in date order, so the year
  // is inferred by walking top to bottom and rolling forward whenever a date
  // goes backwards -- what a Dec->Jan boundary looks like in an unyeared list.
  function parseEvents(text, today) {
    today = today || new Date();
    let year = today.getFullYear();
    let prev = null; // {y,m,d} comparable
    const out = [];
    (text || '').split('\n').forEach(function (raw) {
      const line = raw.trim();
      if (!line) return;
      const m = EVENT_RE.exec(line);
      if (!m) return;
      const month = MONTHS[m[1].toLowerCase()];
      if (!month) return;
      const day = parseInt(m[2], 10);

      function valid(y) {
        const d = new Date(y, month - 1, day);
        return d.getFullYear() === y && d.getMonth() === month - 1 && d.getDate() === day;
      }
      if (!valid(year)) return; // e.g. Feb 30
      let key = year * 10000 + month * 100 + day;
      if (prev !== null && key < prev) {
        year += 1;
        if (!valid(year)) return;
        key = year * 10000 + month * 100 + day;
      }
      prev = key;
      out.push({ date: year + '-' + pad(month) + '-' + pad(day), title: m[3].trim(), raw: line });
    });
    return out;
  }

  function parseStanding(text) {
    const out = [];
    const seen = {};
    (text || '').split('\n').forEach(function (raw) {
      const line = raw.trim();
      if (!line || seen[line]) return;
      const m = EVENT_RE.exec(line);
      if (m && MONTHS[m[1].toLowerCase()]) return; // it's a dated event line
      const low = line.toLowerCase();
      if (STANDING_KEYWORDS.some(function (k) { return low.indexOf(k) !== -1; })) {
        out.push(line);
        seen[line] = true;
      }
    });
    return out;
  }

  // ── Standing notes as date ranges ─────────────────────────────────────────
  // A standing note usually refers to a stretch of dates ("not to travel the
  // week after 22nd Aug", "away Sep 1 to 5"). Check Date should only surface it
  // when the date being checked falls inside that stretch -- not on every date.
  // Returns [{ text, start, end }] where start/end are YYYY-MM-DD, or null when
  // no range can be read (then the caller shows it always, erring safe).
  const MONTH_ALT = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

  function isoOf(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
  function shift(y, m, d, n) {
    const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + n);
    return isoOf(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }
  function yearFor(m, d, today) {
    // The note carries no years. Choose the one that keeps the date from being
    // far in the past, so "22nd Aug" checked in August means this year.
    let y = today.getFullYear();
    if ((today - new Date(y, m - 1, d)) / 86400000 > 180) y += 1;
    return y;
  }

  // Pull dates out of a line in reading order, pairing loose day-numbers with
  // the month in effect -- handles "22 Aug", "Aug 22", "Sep 1 to 5", "Dec 20-31".
  function datesIn(line, today) {
    const tokenRe = new RegExp('(' + MONTH_ALT + ')|(\\d{1,2})(?:st|nd|rd|th)?', 'gi');
    const dates = [];
    let pendingDays = [];
    let curMonth = null;
    let m2;
    while ((m2 = tokenRe.exec(line)) !== null) {
      if (m2[1]) {
        curMonth = MONTHS[m2[1].toLowerCase()];
        pendingDays.forEach(function (d) { dates.push({ m: curMonth, d: d }); });
        pendingDays = [];
      } else if (m2[2]) {
        const day = parseInt(m2[2], 10);
        if (day < 1 || day > 31) continue;
        if (curMonth) dates.push({ m: curMonth, d: day });
        else pendingDays.push(day);
      }
    }
    return dates.map(function (x) {
      const y = yearFor(x.m, x.d, today);
      return { y: y, m: x.m, d: x.d, iso: isoOf(y, x.m, x.d) };
    });
  }

  function standingNotes(text, today) {
    today = today || new Date();
    return parseStanding(text).map(function (line) {
      const low = line.toLowerCase();
      const dates = datesIn(line, today);
      let start = null, end = null;
      if (dates.length) {
        if (/week\s+after/.test(low)) {
          const a = dates[dates.length - 1];
          start = shift(a.y, a.m, a.d, 1); end = shift(a.y, a.m, a.d, 7);
        } else if (/week\s+of/.test(low)) {
          const a = dates[0];
          start = a.iso; end = shift(a.y, a.m, a.d, 6);
        } else if (dates.length >= 2 && /(\bto\b|\bthrough\b|\bthru\b|\buntil\b|\btill\b|-|–|\bbetween\b|\band\b)/.test(low)) {
          start = dates[0].iso; end = dates[1].iso;
        } else if (dates.length === 1) {
          start = dates[0].iso; end = dates[0].iso;
        }
        if (start && end && end < start) { const t = start; start = end; end = t; }
      }
      return { text: line, start: start, end: end };
    });
  }

  // True if a standing note applies on the given date. No parsed range means
  // it applies always (safer to over-show a vague note than to hide it).
  function standingApplies(note, dateStr) {
    if (!note.start || !note.end) return true;
    return dateStr >= note.start && dateStr <= note.end;
  }

  const GIG_WORDS = ['magic', 'show', 'gig', 'performance'];

  // Is a gig already written on this date? Matches loosely -- her hand-typed
  // "Aug 31st Magic show at 7 pm" and an auto line "Aug 31 Magic Show" are the
  // same gig, so a date with any show-like line counts as covered.
  function hasGigOn(text, dateStr) {
    return parseEvents(text).some(function (e) {
      if (e.date !== dateStr) return false;
      const t = e.title.toLowerCase();
      return GIG_WORDS.some(function (w) { return t.indexOf(w) !== -1; });
    });
  }

  // Inserts a line in date order, so gigs land inline among the family
  // entries exactly as the note reads now -- never clubbed at the top. Comment
  // lines with no date are left where they are.
  function insertByDate(text, dateStr, line) {
    const lines = (text || '').split('\n');
    const events = parseEvents(text);
    // First dated line that falls AFTER the new date; insert just before it.
    let anchorRaw = null;
    for (let i = 0; i < events.length; i++) {
      if (events[i].date > dateStr) { anchorRaw = events[i].raw; break; }
    }
    if (anchorRaw === null) {
      // Nothing later -- append at the end (trim a trailing blank line first).
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push(line);
      return lines.join('\n');
    }
    const idx = lines.findIndex(function (l) { return l.trim() === anchorRaw; });
    if (idx === -1) { lines.push(line); return lines.join('\n'); }
    lines.splice(idx, 0, line);
    return lines.join('\n');
  }

  window.FamilyNote = {
    parseEvents: parseEvents, parseStanding: parseStanding,
    standingNotes: standingNotes, standingApplies: standingApplies,
    hasGigOn: hasGigOn, insertByDate: insertByDate,
  };
})();
