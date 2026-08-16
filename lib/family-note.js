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

  window.FamilyNote = { parseEvents: parseEvents, parseStanding: parseStanding };
})();
