// The family note, from the server.
//
// A DELIBERATE MIRROR of the parts of lib/family-note.js the backend needs, and
// the duplication is the lesser evil: that file is loaded by four pages as a
// classic <script>, so it cannot carry an `export` without throwing a syntax
// error in every one of them. Reading and evaluating it here instead would
// depend on Vercel shipping a non-imported file into the lambda, which it does
// not promise to do.
//
// KEEP IN STEP with lib/family-note.js. Only three rules matter here and all
// three are copied exactly:
//   - the dated-line shape, "Mon D[st|nd|rd|th] rest"
//   - the year anchoring: this year unless comfortably past, then next
//   - a date already carrying a gig-like line is left alone
//
// Everything else that file does -- ranges, standing notes, away days -- is
// only needed by the pages and is not repeated.

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const EVENT_RE = /^\s*([A-Za-z]{3,9})\s*(\d{1,2})(?:st|nd|rd|th)?\s*[-–:,]?\s*(.*)$/;
const GIG_WORDS = ['magic', 'show', 'gig', 'performance'];
// Copied, not chosen: lib/family-note.js uses 90, and a different number here
// would put a line in a different year from the one the pages show it in.
const GRACE_PAST_DAYS = 90;

const pad = (n) => String(n).padStart(2, '0');
const validOn = (y, m, d) => {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
};

/** Every dated line, as { date: 'YYYY-MM-DD', title, raw }. */
export function parseEvents(text, today = new Date()) {
  const baseYear = today.getFullYear();
  const todayMid = new Date(baseYear, today.getMonth(), today.getDate());
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = EVENT_RE.exec(line);
    if (!m) continue;
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) continue;
    const day = parseInt(m[2], 10);
    let year = baseYear;
    if (!validOn(year, month, day)) {
      if (validOn(year + 1, month, day)) year += 1; else continue;
    }
    const daysOut = Math.round((new Date(year, month - 1, day) - todayMid) / 86400000);
    if (daysOut < -GRACE_PAST_DAYS && validOn(year + 1, month, day)) year += 1;
    out.push({ date: `${year}-${pad(month)}-${pad(day)}`, title: m[3].trim(), raw: line });
  }
  return out;
}

/** Is a gig already written on this date? Loose on purpose: a hand-typed
 *  "Oct 9th Magic show at 7 PM" and an added "Oct 9 Magic show" are one gig. */
export function hasGigOn(text, dateISO) {
  return parseEvents(text).some((e) =>
    e.date === dateISO && GIG_WORDS.some((w) => e.title.toLowerCase().includes(w)));
}

/** Inserts in date order, so a gig lands inline among the family entries
 *  rather than clubbed at the top. Undated comment lines stay where they are. */
export function insertByDate(text, dateISO, line) {
  const lines = String(text || '').split('\n');
  const later = parseEvents(text).find((e) => e.date > dateISO);
  if (!later) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(line);
    return lines.join('\n');
  }
  const idx = lines.findIndex((l) => l.trim() === later.raw);
  if (idx === -1) { lines.push(line); return lines.join('\n'); }
  lines.splice(idx, 0, line);
  return lines.join('\n');
}

const ORDINAL = (d) => {
  if (d % 100 >= 11 && d % 100 <= 13) return `${d}th`;
  return `${d}${['th', 'st', 'nd', 'rd'][d % 10] || 'th'}`;
};
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-09" -> "Oct 9th", the form the note is written in. */
export function humanDate(dateISO) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  if (!y || !m || !d) return dateISO;
  return `${SHORT[m - 1]} ${ORDINAL(d)}`;
}

/** "19:00" -> "7 PM". Passes through anything already written that way. */
export function prettyTime(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return s;
  let h = parseInt(m[1], 10);
  const mins = m[2];
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 === 0 ? 12 : h % 12;
  return mins === '00' ? `${h} ${suffix}` : `${h}:${mins} ${suffix}`;
}
