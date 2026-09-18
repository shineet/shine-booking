// lib/trip-line.js
// One plan entry as a line of text, and back again.
//
// The trip page used to be a form: a bottom sheet with six labelled fields for
// every single thing anyone wanted to add. This turns an entry into a line you
// type, the way the family calendar works -- except the family note stores the
// TEXT and parses it on read, and this does not. Here the text is only ever an
// interface. What is stored is still one row per item.
//
// That distinction is the whole design. trip_plan.sql says why: eight people
// editing one blob of text is last-write-wins, and somebody's dinner booking
// quietly disappears. Rows keep two people editing different things from
// colliding. So: a note to type into, rows underneath.
//
//     9:30  Prado Museum @Museo del Prado #activity ✓
//           Tickets booked, meet in the lobby
//
// NOTHING IS EVER LOST TO A SYNTAX ERROR. Every rule below is a pattern that
// either matches or does not; whatever is left over becomes the title, verbatim.
// A line that follows none of the rules is a perfectly good entry with a long
// name. That is deliberate -- the family note's rule that a line must start with
// a month meant "Party on Aug 29th" was silently ignored and nothing said so,
// and this page is used by eight people who did not write the rules.
//
// Loaded as a plain script by spain.html and required directly by the tests, so
// it attaches to `window` in a browser and to `module.exports` under Node,
// exactly like lib/family-note.js.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TripLine = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // The kinds an entry can be. Unknown tags are NOT categories: "#1 rated" is
  // part of a name, not a filing decision, and eating it would silently change
  // what the row means.
  const CATEGORIES = ['activity', 'plan', 'food', 'travel', 'stay', 'note'];

  // What a new typed line is when it says nothing. Activity, because once
  // everyone is actually in Spain almost everything added is something to do or
  // something to eat, and the common case should cost no typing.
  //
  // It is also the one category `format` leaves off, which is what makes a
  // round trip exact: the tag it omits is the value parse assumes.
  const DEFAULT_CATEGORY = 'activity';

  // A leading time. The column is free text on purpose (trip_plan.sql: "free
  // text so 'morning' works"), so this is generous rather than strict: a clock
  // time in either notation, or one of the words people actually write.
  //
  // Anchored, and requires a space after, so a title beginning with a number --
  // "3 Michelin stars" -- keeps its number instead of losing it to a field
  // nobody asked to fill.
  // Only words that are a time and nothing else.
  //
  // This list had "dinner", "breakfast", "lunchtime" and "night" in it, and the
  // round-trip test caught what that does: "Dinner at Botin" parsed as a thing
  // called "at Botin" happening at "dinner". Those words start a NAME far more
  // often than they give a time, and losing the first word of what somebody
  // typed is the worst thing this file could do.
  //
  // "Morning walk" becoming a walk in the morning is fine, and is the reason
  // the surviving six stay. A meal is not.
  const WORD_TIMES = ['morning', 'afternoon', 'evening', 'noon', 'midnight', 'midday'];
  const TIME_RE = new RegExp(
    '^(' +
      '\\d{1,2}:\\d{2}\\s*(?:am|pm)?' +   // 9:30, 09:30, 9:30pm
      '|\\d{1,2}\\s*(?:am|pm)' +          // 9am, 9 pm
      '|' + WORD_TIMES.join('|') +
    ')(?=\\s|$)', 'i');

  // Ticked. A standalone token only, so a tick inside a name survives.
  const BOOKED_RE = /(^|\s)(✓|✔|\[x\]|\[X\])(?=\s|$)/;

  const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  /// Parse one entry, which may be a first line plus indented continuation
  /// lines that become the detail.
  ///
  /// `opts.defaultCategory` lets a caller say what an untagged line means. The
  /// page passes nothing (so: activity) for something newly typed, and passes
  /// the item's existing category when re-parsing an edit, so editing the name
  /// of an old row filed under "plan" does not silently re-file it.
  function parse(text, opts) {
    const options = opts || {};
    const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const lines = raw.split('\n');
    const head = lines.length ? lines[0] : '';
    // Everything after the first line is the detail, with one level of the
    // indent that made it look like a continuation removed.
    const detail = lines.slice(1)
      .map((l) => l.replace(/^[ \t]{1,8}/, ''))
      .join('\n')
      .replace(/\s+$/, '');

    let rest = head.trim();
    const out = {
      at_time: '',
      title: '',
      place: '',
      category: options.defaultCategory || DEFAULT_CATEGORY,
      booked: false,
      detail,
    };

    // 1. Ticked, anywhere, as its own token.
    const tick = rest.match(BOOKED_RE);
    if (tick) {
      out.booked = true;
      rest = (rest.slice(0, tick.index) + ' ' + rest.slice(tick.index + tick[0].length)).trim();
    }

    // 2. A known #kind, anywhere. Removed before the place is read, so
    //    "@Museo del Prado #activity" does not file the tag as part of the
    //    address.
    for (const cat of CATEGORIES) {
      const re = new RegExp('(^|\\s)#' + cat + '(?=\\s|$)', 'i');
      const m = rest.match(re);
      if (m) {
        out.category = cat;
        rest = (rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length)).trim();
        break;
      }
    }

    // 3. @place, to the end of the line. Places have spaces in them -- "Museo
    //    del Prado", "Calle Ruiz de Alarcon 23" -- so this cannot stop at one
    //    word.
    //
    //    Only at a word boundary. Without that, "email shine@texasmentalist.com"
    //    would file a domain as the place and drop it out of the title.
    const at = rest.match(/(^|\s)@(.+)$/);
    if (at) {
      out.place = squash(at[2]);
      rest = rest.slice(0, at.index).trim();
    }

    // 4. A leading time.
    const t = rest.match(TIME_RE);
    if (t) {
      out.at_time = normaliseTime(t[1]);
      rest = rest.slice(t[0].length).trim();
    }

    // 5. Whatever survived is the name, exactly as written.
    out.title = squash(rest);
    return out;
  }

  /// Tidy a typed time into what the column holds, without inventing one.
  ///
  /// "9:30" stays "9:30" because that is what the picker used to store and what
  /// fmtTime already renders. "9pm" becomes "21:00" so it sorts with the rest --
  /// trip_items is ordered by at_time, and a list where 9pm sorts before 10am
  /// reads as broken even though every row is right.
  function normaliseTime(text) {
    const s = String(text).trim().toLowerCase().replace(/\s+/g, '');
    let m = s.match(/^(\d{1,2}):(\d{2})(am|pm)?$/);
    if (m) {
      let h = Number(m[1]);
      if (m[3] === 'pm' && h < 12) h += 12;
      if (m[3] === 'am' && h === 12) h = 0;
      return String(h).padStart(2, '0') + ':' + m[2];
    }
    m = s.match(/^(\d{1,2})(am|pm)$/);
    if (m) {
      let h = Number(m[1]);
      if (m[2] === 'pm' && h < 12) h += 12;
      if (m[2] === 'am' && h === 12) h = 0;
      return String(h).padStart(2, '0') + ':00';
    }
    return String(text).trim().toLowerCase();
  }

  /// The line a stored item is shown as, and the exact text the editor puts in
  /// front of someone who taps it.
  ///
  /// parse(format(item)) must give the item back. That is the property the
  /// tests hold this to, because it is what stops an edit that changed nothing
  /// from quietly changing something.
  function format(item) {
    const it = item || {};
    const bits = [];
    if (it.at_time) bits.push(String(it.at_time).trim());
    if (it.title) bits.push(squash(it.title));
    if (it.place) bits.push('@' + squash(it.place));
    const cat = (it.category || DEFAULT_CATEGORY).toLowerCase();
    if (cat !== DEFAULT_CATEGORY && CATEGORIES.indexOf(cat) !== -1) bits.push('#' + cat);
    if (it.booked) bits.push('✓');
    const head = bits.join(' ');
    const detail = String(it.detail == null ? '' : it.detail).replace(/\s+$/, '');
    if (!detail) return head;
    // Indented, so the block reads as one entry rather than two.
    return head + '\n' + detail.split('\n').map((l) => '  ' + l).join('\n');
  }

  /// Whether a parsed line says anything at all. An entry with no name and no
  /// time and no place is somebody who tapped into an empty line and tapped out
  /// again, and must not become a row.
  function isEmpty(parsed) {
    const p = parsed || {};
    return !p.title && !p.at_time && !p.place && !p.detail;
  }

  return { parse, format, isEmpty, CATEGORIES, DEFAULT_CATEGORY, normaliseTime };
});
