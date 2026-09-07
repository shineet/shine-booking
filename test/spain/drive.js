// Drives spain.html against the stub, in a real DOM, and checks what a person
// would actually see and do: unlock, read the plan, add something, edit it,
// mark it booked, delete it, and see somebody else's change appear.
const { JSDOM } = require('jsdom');
const fs = require('fs');

let fails = 0, total = 0;
const check = (label, ok, extra = '') => {
  total++;
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (extra ? '  ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const URL_UNDER_TEST = process.env.TRIP_URL || 'http://localhost:8412/spain.html';

(async () => {
  // The stub is started here so every run begins from the same plan. Leaving a
  // shared one running between runs made an earlier pass fail on data the
  // previous pass had added, which reads exactly like a bug in the page.
  const { spawn } = require('child_process');
  const stub = spawn('node', [__dirname + '/stub.js'], { stdio: 'inherit' });
  stub.on('exit', (code) => {
    if (code) { console.error('the stub died, so nothing below means anything'); process.exit(1); }
  });
  const stop = () => { try { stub.kill(); } catch (e) {} };
  process.on('exit', stop);
  await sleep(700);

  const html = fs.readFileSync('/Users/shinethankappan/Projects/shine-booking/spain.html', 'utf8');
  const dom = new JSDOM(html, {
    url: URL_UNDER_TEST,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      // Node's fetch has no notion of a page origin, so relative URLs need
      // resolving. The page itself is unchanged.
      w.fetch = (u, o) => fetch(new URL(u, 'http://localhost:8412').toString(), o);
      w.confirm = () => true;
      w.alert = () => {};
      w.prompt = (msg, def) => w.__nextPrompt !== undefined ? w.__nextPrompt : def;
    },
  });
  const w = dom.window, d = w.document;
  const $ = s => d.querySelector(s);
  const all = s => Array.from(d.querySelectorAll(s));
  const text = s => ($(s) || {}).textContent || '';

  await sleep(300);

  // ── The gate ──────────────────────────────────────────────────────────────
  check('starts locked', !$('#gate').classList.contains('hidden'));
  check('the plan is not visible before the PIN', $('#app').classList.contains('hidden'));

  $('#pin').value = '0000';
  await w.submitPin(); await sleep(200);
  check('a wrong PIN says so', text('#gate-err').includes('Wrong'));
  check('and stays locked', $('#app').classList.contains('hidden'));

  w.__nextPrompt = 'Shine';
  $('#pin').value = '4321';
  await w.submitPin(); await sleep(500);
  check('the right PIN opens it', !$('#app').classList.contains('hidden'));

  // ── What you see ──────────────────────────────────────────────────────────
  check('six days are shown', all('#days .day').length === 6, `got ${all('#days .day').length}`);
  check('the date range is in the header', /Oct/.test(text('#range')), text('#range'));
  const cities = all('.day-head .city').map(b => b.textContent);
  check('cities show', cities[0] === 'Madrid' && cities[5] === 'Barcelona', cities.join(', '));
  check('items appear under their day', all('#days .day')[0].querySelectorAll('.item').length === 2);
  check('a day with nothing says so', /Nothing planned/.test(all('#days .day')[2].textContent));
  check('times are shown on the clock people here read',
        /11:40 AM/.test(all('#days .day')[0].textContent),
        (all('#days .day')[0].textContent.match(/\d+:\d+\s*[AP]M/) || [''])[0]);
  check('and an evening time reads as PM',
        /8:00 PM/.test(all('#days .day')[0].textContent),
        all('#days .day')[0].textContent.slice(0, 120));
  check('a booked thing is ticked', /✓/.test(all('#days .day')[0].textContent));
  check('who added it is shown', /added by Priya/.test(all('#days .day')[0].textContent));
  check('a map link is offered', !!all('#days .day')[0].querySelector('a.map'));
  const mapHref = all('#days .day')[0].querySelector('a.map').href;
  check('and it points at Maps', mapHref.startsWith('https://www.google.com/maps/search/'), mapHref.slice(0, 60));
  all('#days .day')[0].querySelector('a.map').click(); await sleep(60);
  check('and tapping it does not open the editor', !$('#sheet').classList.contains('open'));

  // ── Adding ────────────────────────────────────────────────────────────────
  const day3 = all('#days .day')[2];
  day3.querySelector('.add').click(); await sleep(50);
  check('the sheet opens on Add', $('#sheet').classList.contains('open'));
  check('and names the day being added to', /Add to/.test(text('#sheet-title')), text('#sheet-title'));

  $('#f-title').value = 'Segovia day trip';
  $('#f-time').value = '08:15';
  $('#f-place').value = 'Segovia, Spain';
  $('#f-detail').value = 'Train from Chamartin. Aqueduct then lunch.';
  $('#f-cat').value = 'travel';
  await w.saveItem(); await sleep(400);
  check('the sheet closes after saving', !$('#sheet').classList.contains('open'));
  const day3After = all('#days .day')[2];
  check('the new thing is on the right day', /Segovia day trip/.test(day3After.textContent));
  check('with its time, on the twelve hour clock', /8:15 AM/.test(day3After.textContent),
        day3After.textContent.slice(0, 100));
  check('and attributed to you', /added by Shine/.test(day3After.textContent));
  check('the day no longer says empty', !/Nothing planned/.test(day3After.textContent));

  // An entry with no name should be refused rather than saved blank.
  day3After.querySelector('.add').click(); await sleep(50);
  $('#f-title').value = '   ';
  await w.saveItem(); await sleep(200);
  check('a nameless entry is refused', $('#sheet').classList.contains('open') && /name/i.test(text('#sheet-err')));
  w.closeSheet();

  // ── Editing ───────────────────────────────────────────────────────────────
  const segovia = Array.from(all('#days .day')[2].querySelectorAll('.item'))
    .find(n => /Segovia/.test(n.textContent));
  // The row is informational. Reading the plan must not be the same gesture as
  // opening an editor with a Delete button in it.
  segovia.click(); await sleep(60);
  check('tapping the row itself does nothing', !$('#sheet').classList.contains('open'));
  check('every row offers an edit button instead',
        all('.item').every(n => !!n.querySelector('.edit')));
  segovia.querySelector('.edit').click(); await sleep(60);
  check('the edit button opens it', $('#sheet').classList.contains('open'));
  check('its fields are filled in', $('#f-title').value === 'Segovia day trip', $('#f-title').value);
  check('delete is offered on an existing item', !$('#f-del').classList.contains('hidden'));

  $('#f-booked').checked = true;
  $('#f-title').value = 'Segovia day trip (booked)';
  await w.saveItem(); await sleep(400);
  const edited = Array.from(all('#days .day')[2].querySelectorAll('.item')).find(n => /Segovia/.test(n.textContent));
  check('the edit shows', /Segovia day trip \(booked\)/.test(edited.textContent));
  check('and it is marked booked', edited.classList.contains('booked'));

  // ── Somebody else changes the plan ────────────────────────────────────────
  await fetch('http://localhost:8412/api/get-booking', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'db', token: 'stub-token', method: 'POST', path: 'trip_items',
      body: { trip: 'spain', day_id: 'd5', at_time: '19:00', title: 'Tapas crawl, El Born',
              detail: 'Anil is booking', place: 'El Born, Barcelona', category: 'food',
              booked: false, author: 'Anil' } }),
  });
  await w.load(true); await sleep(400);
  check("somebody else's addition appears", /Tapas crawl/.test(all('#days .day')[4].textContent));

  // ── Changing a city and the dates ────────────────────────────────────────
  // Driven through the DOM, the way a person would, rather than by reaching
  // for the page's own variables.
  w.__nextPrompt = 'Toledo';
  all('.day-head .city')[2].click(); await sleep(500);
  check('a city can be changed', all('.day-head .city')[2].textContent === 'Toledo',
        all('.day-head .city')[2].textContent);

  w.__nextPrompt = '2026-10-20';
  Array.from(d.querySelectorAll('.who button')).find(b => /trip dates/.test(b.textContent)).click();
  await sleep(1500);
  const heads = all('.day-head .d').map(n => n.textContent);
  check('moving the first day shifts them all', /Oct 20/.test(heads[0]) && /Oct 25/.test(heads[5]),
        heads[0] + ' to ' + heads[5]);
  const stillThere = all('#days .day')[2].textContent;
  check('and the plans stay with their day', /Segovia/.test(stillThere) && /Toledo/.test(stillThere));

  // ── Deleting ─────────────────────────────────────────────────────────────
  const toGo = Array.from(all('#days .day')[2].querySelectorAll('.item')).find(n => /Segovia/.test(n.textContent));
  toGo.querySelector('.edit').click(); await sleep(60);

  // Saying no to the confirmation must actually mean no.
  w.confirm = () => false;
  await w.deleteItem(); await sleep(400);
  check('declining the confirmation keeps it', /Segovia/.test(all('#days .day')[2].textContent));

  w.confirm = (msg) => { w.__confirmMsg = msg; return true; };
  await w.deleteItem(); await sleep(400);
  check('a deleted thing goes', !/Segovia/.test(all('#days .day')[2].textContent));
  check('and the confirmation named it and warned there is no undo',
        /Segovia/.test(w.__confirmMsg || '') && /no undo/.test(w.__confirmMsg || ''),
        (w.__confirmMsg || '').replace(/\n/g, ' '));

  // ── Offline ──────────────────────────────────────────────────────────────
  check('the plan is cached for a bad connection', !!w.localStorage.getItem('spainPlanCache'));
  const cached = JSON.parse(w.localStorage.getItem('spainPlanCache'));
  check('and the cache holds the days and items', cached.days.length === 6 && cached.items.length >= 4,
        `${cached.days.length} days, ${cached.items.length} items`);

  // ── Escaping ─────────────────────────────────────────────────────────────
  // Eight people type into this. A title must never become markup.
  await fetch('http://localhost:8412/api/get-booking', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'db', token: 'stub-token', method: 'POST', path: 'trip_items',
      body: { trip: 'spain', day_id: 'd6', title: '<img src=x onerror=alert(1)>', detail: '</div><script>bad()<\/script>',
              place: '', category: 'plan', booked: false, author: 'x', at_time: '' } }),
  });
  await w.load(true); await sleep(400);
  const day6 = all('#days .day')[5];
  check('a title that looks like markup stays text', day6.querySelectorAll('img').length === 0);
  check('and is shown literally', /<img src=x/.test(day6.textContent));
  check('no script tag is created', d.querySelectorAll('script').length === 1,
        `${d.querySelectorAll('script').length} scripts`);

  // ── The shared link ──────────────────────────────────────────────────────
  // A second visitor, opening the link with the PIN in it, must never see the
  // gate and must not be left holding the PIN in the address bar.
  {
    const d2 = new JSDOM(html, {
      url: 'http://localhost:8412/spain.html#4321',
      runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(w2) {
        w2.fetch = (u, o) => fetch(new URL(u, 'http://localhost:8412').toString(), o);
        w2.prompt = () => 'Anil'; w2.alert = () => {}; w2.confirm = () => true;
      },
    });
    await sleep(1500);
    const w2 = d2.window, q = s2 => w2.document.querySelector(s2);
    check('the link opens straight into the plan', q('#app') && !q('#app').classList.contains('hidden'));
    check('without ever showing the gate', q('#gate').classList.contains('hidden'));
    check('the days are there for them too', w2.document.querySelectorAll('#days .day').length === 6);
    check('and the PIN is wiped from the address bar', !w2.location.hash, w2.location.href);

    const d3 = new JSDOM(html, {
      url: 'http://localhost:8412/spain.html#9999',
      runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(w3) {
        w3.fetch = (u, o) => fetch(new URL(u, 'http://localhost:8412').toString(), o);
        w3.prompt = () => ''; w3.alert = () => {}; w3.confirm = () => true;
      },
    });
    await sleep(1500);
    const w4 = d3.window;
    check('a stale link still asks rather than letting anyone in',
          !w4.document.querySelector('#gate').classList.contains('hidden'));
    check('and says the link is out of date',
          /out of date/.test(w4.document.querySelector('#gate-err').textContent));

    const d4 = new JSDOM(html, {
      url: 'http://localhost:8412/spain.html',
      runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(w5) {
        w5.fetch = (u, o) => fetch(new URL(u, 'http://localhost:8412').toString(), o);
        w5.prompt = () => ''; w5.alert = () => {}; w5.confirm = () => true;
      },
    });
    await sleep(600);
    check('the bare URL still asks for the PIN',
          !d4.window.document.querySelector('#gate').classList.contains('hidden'));
  }

  // ── The plan survives the money tables not existing yet ──────────────────
  // Until the SQL is run, asking for them 404s. The plan must still load.
  {
    const gone = new JSDOM(html, {
      url: 'http://localhost:8412/spain.html#4321',
      runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(wx) {
        wx.prompt = () => 'X'; wx.alert = () => {}; wx.confirm = () => true;
        wx.fetch = (u, o) => {
          const body = o && o.body ? JSON.parse(o.body) : {};
          if (body.action === 'db' && /trip_people|trip_expenses/.test(body.path || '')) {
            return Promise.resolve(new Response('{"message":"no such table"}',
              { status: 404, headers: { 'Content-Type': 'application/json' } }));
          }
          return fetch(new URL(u, 'http://localhost:8412').toString(), o);
        };
      },
    });
    await sleep(1500);
    const wx = gone.window;
    check('the plan still loads when the money tables are missing',
          wx.document.querySelectorAll('#days .day').length === 6,
          wx.document.querySelectorAll('#days .day').length + ' days');
    check('and the flights are still there', /BA/.test(wx.document.getElementById('days').textContent) ||
          wx.document.getElementById('days').textContent.length > 50);
    wx.document.getElementById('tab-money').click();
    await sleep(80);
    check('and Money says why it is empty rather than looking broken',
          /not switched on yet/.test(wx.document.getElementById('m-settle').textContent),
          wx.document.getElementById('m-settle').textContent.slice(0, 60));
  }

  // Opening on the right day.
  {
    const rows = await (await fetch('http://localhost:8412/api/get-booking', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'db', token: 'stub-token', method: 'GET', path: 'trip_days' }),
    })).json();
    rows.sort((a, b) => a.sort_index - b.sort_index);

    check('before the trip it opens at the top',
          w.dayToOpenOn(rows, '2020-01-01') === null);
    check('after the trip it opens at the top too',
          w.dayToOpenOn(rows, '2099-01-01') === null);
    check('during the trip it opens on that day',
          (w.dayToOpenOn(rows, rows[3].date) || {}).id === rows[3].id);
    check('the first day counts as during',
          (w.dayToOpenOn(rows, rows[0].date) || {}).id === rows[0].id);
    check('and so does the last',
          (w.dayToOpenOn(rows, rows[rows.length - 1].date) || {}).id === rows[rows.length - 1].id);
    check('no days at all does not blow up', w.dayToOpenOn([], '2026-10-14') === null);
    check('and neither does nothing at all', w.dayToOpenOn(null, '2026-10-14') === null);

    // The date the page thinks it is has to be the local one.
    const local = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    check("today is the phone's date, not UTC's",
          w.todayISO() === local.getFullYear() + '-' + pad(local.getMonth() + 1) + '-' + pad(local.getDate()),
          w.todayISO());

    // Every card is addressable, which is what the jump needs.
    check('every day card can be found by its id',
          all('#days .day').every(c => !!c.dataset.day),
          all('#days .day').length + ' cards');
    check('and none is marked today, since the trip is not now',
          d.querySelectorAll('#days .day.today').length === 0);

    // The wiring, not just the decision. Move one day onto today's date and
    // open the page fresh: it should mark that card and scroll to it.
    const target = rows[2];
    await fetch('http://localhost:8412/api/get-booking', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'db', token: 'stub-token', method: 'PATCH',
        path: 'trip_days?id=eq.' + target.id, body: { date: w.todayISO() } }),
    });

    let scrolledTo = null;
    const live = new JSDOM(html, {
      url: 'http://localhost:8412/spain.html#4321',
      runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(wl) {
        wl.fetch = (u, o) => fetch(new URL(u, 'http://localhost:8412').toString(), o);
        wl.prompt = () => 'X'; wl.alert = () => {}; wl.confirm = () => true;
        wl.Element.prototype.scrollIntoView = function () { scrolledTo = this.dataset.day; };
      },
    });
    await sleep(1600);
    const dl = live.window.document;
    check('the day that is today is marked',
          dl.querySelectorAll('#days .day.today').length === 1,
          dl.querySelectorAll('#days .day.today').length + ' marked');
    check('and it says so on the card', /today/.test(dl.querySelector('#days .day.today').textContent));
    check('and the page opened on it', scrolledTo === target.id, String(scrolledTo));

    // Put it back so nothing after this depends on the trip being now.
    await fetch('http://localhost:8412/api/get-booking', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'db', token: 'stub-token', method: 'PATCH',
        path: 'trip_days?id=eq.' + target.id, body: { date: target.date } }),
    });
  }

  // Reading a time. Stored as 24 hour so the list sorts, shown as 12 hour.
  check('morning', w.fmtTime('09:30') === '9:30 AM', w.fmtTime('09:30'));
  check('afternoon', w.fmtTime('13:05') === '1:05 PM', w.fmtTime('13:05'));
  check('midnight is 12 AM, not 0', w.fmtTime('00:15') === '12:15 AM', w.fmtTime('00:15'));
  check('noon is 12 PM, not 0', w.fmtTime('12:00') === '12:00 PM', w.fmtTime('12:00'));
  check('one minute to midnight', w.fmtTime('23:59') === '11:59 PM', w.fmtTime('23:59'));
  check('no time stays empty', w.fmtTime('') === '');
  check('and anything that is not a time is left alone', w.fmtTime('Morning') === 'Morning');

  // The time field is the native picker, which on a phone is a wheel with AM
  // and PM on it rather than something to type.
  check('the time field uses the native picker', $('#f-time').type === 'time', $('#f-time').type);
  check('and the map field says it takes either',
        /Place or address/.test(d.querySelector('label[for=f-place]').textContent),
        d.querySelector('label[for=f-place]').textContent);

  // ── Money ────────────────────────────────────────────────────────────────
  // The arithmetic first, directly, because a settlement that is a few cents
  // out looks completely plausible and is wrong.
  {
    const P = (n) => ({ id: 'p' + n, name: 'P' + n });
    const four = [P(1), P(2), P(3), P(4)];
    const ids = four.map(p => p.id);
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

    const three = w.shareOut(10000, ['a', 'b', 'c']);
    check('100.00 three ways adds back up to 100.00', sum(three) === 10000, JSON.stringify(three));
    check('and the odd cent goes to one of them, not nowhere',
          three.a === 3334 && three.b === 3333 && three.c === 3333, JSON.stringify(three));
    check('an exact split has no remainder', sum(w.shareOut(10000, ['a','b','c','d'])) === 10000);
    check('one penny among three still balances', sum(w.shareOut(1, ['a','b','c'])) === 1);
    check('splitting between nobody returns nothing',
          Object.keys(w.shareOut(500, [])).length === 0);

    // A pays 60 for the two of them.
    let r = w.settleUp([P(1), P(2)], [
      { amount_cents: 6000, paid_by: 'p1', shared_with: ['p1', 'p2'] }]);
    check('one payment settles two people', r.transfers.length === 1);
    check('and it is 30.00 the right way',
          r.transfers[0].from === 'p2' && r.transfers[0].to === 'p1' && r.transfers[0].amount === 3000,
          JSON.stringify(r.transfers[0]));

    // Paying for others without partaking.
    r = w.settleUp(four, [{ amount_cents: 4000, paid_by: 'p1', shared_with: ['p2', 'p3'] }]);
    check('paying for others but not sharing is owed the whole amount',
          r.transfers.reduce((a, t) => a + (t.to === 'p1' ? t.amount : 0), 0) === 4000);
    check('and somebody left out owes nothing',
          !r.transfers.some(t => t.from === 'p4'));

    // Everything balances, always.
    r = w.settleUp(four, [
      { amount_cents: 12000, paid_by: 'p1', shared_with: ids },
      { amount_cents:  4567, paid_by: 'p2', shared_with: ids },
      { amount_cents:   999, paid_by: 'p3', shared_with: ['p1', 'p3'] },
      { amount_cents:  8000, paid_by: 'p4', shared_with: ['p2', 'p4'] },
    ]);
    check('the balances net to exactly zero', sum(r.net) === 0, String(sum(r.net)));
    check('the total is the sum of everything', r.total === 12000 + 4567 + 999 + 8000, String(r.total));
    check('never more payments than people minus one',
          r.transfers.length <= four.length - 1, r.transfers.length + ' payments');
    const moved = {};
    for (const p of four) moved[p.id] = 0;
    for (const t of r.transfers) { moved[t.from] -= t.amount; moved[t.to] += t.amount; }
    check('and what moves is exactly what each is owed or owes',
          four.every(p => moved[p.id] === r.net[p.id]),
          JSON.stringify(moved) + ' vs ' + JSON.stringify(r.net));

    check('everyone square means nobody pays',
          w.settleUp(four, [
            { amount_cents: 4000, paid_by: 'p1', shared_with: ids },
            { amount_cents: 4000, paid_by: 'p2', shared_with: ids },
            { amount_cents: 4000, paid_by: 'p3', shared_with: ids },
            { amount_cents: 4000, paid_by: 'p4', shared_with: ids },
          ]).transfers.length === 0);
    check('no expenses means nothing owed', w.settleUp(four, []).transfers.length === 0);
    check('an expense naming somebody who has left is skipped, not crashed',
          w.settleUp(four, [{ amount_cents: 5000, paid_by: 'gone', shared_with: ['gone'] }]).total === 0);

    // Converting, and settling across two currencies.
    check('a dollar amount converts at the rate', w.toEurCents(24400, 'USD') === 20000,
          String(w.toEurCents(24400, 'USD')));
    check('euros are left alone', w.toEurCents(24400, 'EUR') === 24400);
    check('a missing currency is treated as euros', w.toEurCents(500, undefined) === 500);
    const mixed = w.settleUp(four, [
      { amount_cents: 9000,  currency: 'EUR', paid_by: 'p1', shared_with: ids },
      { amount_cents: 24400, currency: 'USD', paid_by: 'p2', shared_with: ids },
      { amount_cents: 3333,  currency: 'USD', paid_by: 'p3', shared_with: ['p3','p4'] },
    ]);
    check('a mixed currency settlement still nets to exactly zero',
          Object.values(mixed.net).reduce((a, b) => a + b, 0) === 0,
          String(Object.values(mixed.net).reduce((a, b) => a + b, 0)));
    check('and never needs more than three payments for four people',
          mixed.transfers.length <= 3, mixed.transfers.length + '');

    // Typing when somebody is there. A day of the month is enough.
    //
    // Read the real trip dates rather than assuming them: an earlier test moves
    // the trip, and hardcoding a day here would fail for that reason alone.
    const dayRows = await (await fetch('http://localhost:8412/api/get-booking', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'db', token: 'stub-token', method: 'GET', path: 'trip_days' }),
    })).json();
    const nth = (i) => dayRows[i].date;
    const dom = (i) => Number(nth(i).slice(8, 10));
    const short = dom(1) + ' to ' + dom(4);

    check('a day of the month resolves against the trip', (() => {
      const r = w.parseStay(short);
      return r && r[1] === nth(1) && r[2] === nth(4);
    })(), short + ' -> ' + JSON.stringify(w.parseStay(short)));
    check('a dash works as well as the word', (() => {
      const r = w.parseStay(dom(1) + '-' + dom(4));
      return r && r[1] === nth(1) && r[2] === nth(4);
    })());
    check('full dates still work', (() => {
      const r = w.parseStay(nth(1) + ' to ' + nth(4));
      return r && r[1] === nth(1) && r[2] === nth(4);
    })());
    check('blank means the whole trip', w.parseStay('') === null);
    check('a day not on the trip is refused', w.parseStay('1 to 2') === null);
    check('nonsense is refused', w.parseStay('sometime next week') === null);
    check('and it offers the short form back for editing',
          w.shortRange(nth(1), nth(4)) === short, w.shortRange(nth(1), nth(4)));

    // Who is even on the trip.
    const early = { from_date: '2026-10-13', to_date: '2026-10-15' };
    check('somebody who has not arrived is not there', !w.presentOn(early, '2026-10-11'));
    check('but is on the day they arrive', w.presentOn(early, '2026-10-13'));
    check('and on the day they leave', w.presentOn(early, '2026-10-15'));
    check('and not the day after', !w.presentOn(early, '2026-10-16'));
    check('somebody with no dates is there the whole time', w.presentOn({}, '2026-10-11'));

    // Reading an amount off text, not off a float.
    check('42.50 is 4250', w.toCents('42.50') === 4250);
    check('42 is 4200', w.toCents('42') === 4200);
    check('42.5 is 4250', w.toCents('42.5') === 4250);
    check('a comma works too', w.toCents('42,50') === 4250);
    check('spaces are fine', w.toCents('  42.50 ') === 4250);
    check('words are refused', w.toCents('lots') === null);
    check('empty is refused', w.toCents('') === null);
    check('three decimals are refused', w.toCents('42.505') === null);
  }

  // ── Money, through the page ──────────────────────────────────────────────
  {
    d.getElementById('tab-money').click(); await sleep(60);
    check('the Money tab shows', !$('#money').classList.contains('hidden'));
    check('and hides the plan', $('#days').classList.contains('hidden'));
    check('the four couples are there', d.querySelectorAll('#m-people .chip').length === 5,
          d.querySelectorAll('#m-people .chip').length + ' chips including add');
    check('and the one joining late shows their days', /Dev & Nithya\s+\u00B7\s+\w/.test(text('#m-people')),
          text('#m-people').slice(0, 140));
    check('the rate is stated', /1 = \$1\.22/.test(text('#m-rate')), text('#m-rate'));
    check('nothing spent yet', /Nothing spent yet/.test(text('#m-settle')));

    // An earlier test moved the trip dates, so the day values are whatever they
    // are now. Read them off the page rather than assuming, and line the late
    // couple up with them, so this block does not depend on what ran before it.
    w.openExpense(); await sleep(60);
    check('the expense sheet opens', $('#esheet').style.display === 'flex');
    const dayValues = Array.from(d.querySelectorAll('#e-date option')).map(o => o.value);
    const beforeTheyArrive = dayValues[1], afterTheyArrive = dayValues[4];
    await fetch('http://localhost:8412/api/get-booking', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'db', token: 'stub-token', method: 'PATCH',
        path: 'trip_people?id=eq.fam4',
        body: { from_date: afterTheyArrive, to_date: dayValues[dayValues.length - 1] } }),
    });
    await w.load(true); await sleep(300);
    w.closeExpense(); w.openExpense(); await sleep(60);
    $('#e-date').value = beforeTheyArrive;
    $('#e-date').onchange(); await sleep(50);
    check('only the three who are there are selected',
          d.querySelectorAll('#e-with .chip.on').length === 3,
          d.querySelectorAll('#e-with .chip.on').length + ' selected');
    check('and the couple still at home is marked as not here',
          /Dev & Nithya  \(not here\)/.test(text('#e-with')), text('#e-with'));
    $('#e-amount').value = '90.00';
    $('#e-what').value = 'Dinner at Botin';
    await w.saveExpense(); await sleep(400);
    check('the expense is listed', /Dinner at Botin/.test(text('#m-list')));
    check('and says how many ways it split', /split 3 ways/.test(text('#m-list')));
    check('two payments settle three people', d.querySelectorAll('#m-settle .owe').length === 2,
          d.querySelectorAll('#m-settle .owe').length + ' rows');
    check('each owing 30.00', (text('#m-settle').match(/30\.00/g) || []).length === 2, text('#m-settle'));
    check('and the settlement is shown in dollars too', /\$/.test(text('#m-settle')), text('#m-settle').slice(0,80));

    // A Barcelona expense, paid on a US card in dollars, split all four ways.
    w.openExpense(); await sleep(60);
    $('#e-date').value = afterTheyArrive;
    $('#e-date').onchange(); await sleep(50);
    check('all four are selected once everyone has arrived',
          d.querySelectorAll('#e-with .chip.on').length === 4);
    $('#e-amount').value = '244.00';
    $('#e-cur').value = 'USD';
    $('#e-what').value = 'Sagrada Familia tickets';
    await w.saveExpense(); await sleep(400);
    check('a dollar expense shows as dollars', /\$244\.00/.test(text('#m-list')), text('#m-list').slice(0,90));
    check('and 244 dollars at 1.22 is 200 euros in the total',
          /290\.00/.test(text('#m-total')), text('#m-total'));

    // Nobody can save an expense with no amount.
    w.openExpense(); await sleep(50);
    $('#e-amount').value = ''; $('#e-what').value = 'Nothing';
    await w.saveExpense(); await sleep(150);
    check('an expense with no amount is refused',
          $('#esheet').style.display === 'flex' && /amount/i.test(text('#e-err')));
    w.closeExpense();
  }

  // ── Adding a cost straight from the plan ─────────────────────────────────
  {
    d.getElementById('tab-plan').click(); await sleep(60);
    const dayCards = all('#days .day');
    // A row that can carry a shared bill, which is no longer every row.
    const withStuff = dayCards.find(c => c.querySelector('.item .cost'));
    const row = withStuff.querySelector('.item .cost').closest('.item');
    const what = row.querySelector('.title').textContent.replace(/^\u2713\s*/, '');
    const dayLabel = withStuff.querySelector('.day-head .d').textContent;

    // Nobody splits the cost of landing in Austin or checking out of a hotel,
    // so those rows carry no cost button and the tag beside them says which
    // kind they are.
    const tagOf = i => (i.querySelector('.by .tag') || {}).textContent
      ? i.querySelector('.by .tag').textContent.trim() : 'plan';
    const informational = ['travel', 'stay', 'note'];
    check('rows nobody splits a bill for offer no cost button',
          all('#days .item')
            .filter(i => informational.includes(tagOf(i)))
            .every(i => !i.querySelector('.cost')));
    check('and rows that could be a shared bill still do',
          all('#days .item')
            .filter(i => !informational.includes(tagOf(i)))
            .every(i => !!i.querySelector('.cost')));
    check('there is at least one of each to have proved anything',
          all('#days .item').some(i => informational.includes(tagOf(i)))
          && all('#days .item').some(i => !informational.includes(tagOf(i))));

    row.querySelector('.cost').click(); await sleep(80);
    check('it opens the expense sheet', $('#esheet').style.display === 'flex');
    check('with what it was already filled in', $('#e-what').value === what,
          $('#e-what').value + ' vs ' + what);
    check('and the right day already chosen',
          $('#e-date').options[$('#e-date').selectedIndex].textContent.startsWith(dayLabel),
          $('#e-date').options[$('#e-date').selectedIndex].textContent + ' vs ' + dayLabel);
    check('and the amount left empty, which is all there is to type',
          $('#e-amount').value === '');
    check('split between whoever was there that day',
          d.querySelectorAll('#e-with .chip.on').length >= 3);

    $('#e-amount').value = '120.00';
    await w.saveExpense(); await sleep(500);
    check('saving takes you to Money so you can see it landed',
          !$('#money').classList.contains('hidden'));
    check('and it is there, named after the plan entry',
          text('#m-list').includes(what), text('#m-list').slice(0, 90));
    check('filed against the right day',
          new RegExp(dayLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(text('#m-list')),
          text('#m-list').slice(0, 140));
  }

  // ── Booked and paid goes straight to splitting it ────────────────────────
  {
    d.getElementById('tab-plan').click(); await sleep(60);
    const day = all('#days .day')[1];
    day.querySelector('.add').click(); await sleep(50);
    check('a new entry starts as an activity', $('#f-cat').value === 'activity',
          $('#f-cat').value);
    const dayLabel = day.querySelector('.day-head .d').textContent;

    $('#f-title').value = 'Flamenco show';
    $('#f-cat').value = 'activity';
    $('#f-booked').checked = true;
    await w.saveItem(); await sleep(500);

    check('ticking booked and paid opens the expense sheet',
          $('#esheet').style.display === 'flex');
    check('already named after the thing', $('#e-what').value === 'Flamenco show',
          $('#e-what').value);
    check('and filed against the right day',
          $('#e-date').options[$('#e-date').selectedIndex].textContent.startsWith(dayLabel),
          $('#e-date').options[$('#e-date').selectedIndex].textContent + ' vs ' + dayLabel);
    w.closeExpense(); await sleep(60);

    // Editing something already booked must not ask again, or fixing a typo
    // reopens the money sheet every time.
    d.getElementById('tab-plan').click(); await sleep(60);
    const flamenco = all('#days .item').find(i => /Flamenco show/.test(i.textContent));
    flamenco.querySelector('.edit').click(); await sleep(60);
    $('#f-title').value = 'Flamenco show, Cardamomo';
    await w.saveItem(); await sleep(500);
    check('editing something already booked does not ask again',
          $('#esheet').style.display !== 'flex');

    // A hotel marked paid was one couple paying for one room.
    d.getElementById('tab-plan').click(); await sleep(60);
    all('#days .day')[1].querySelector('.add').click(); await sleep(50);
    $('#f-title').value = 'Hotel balance settled';
    $('#f-cat').value = 'stay';
    $('#f-booked').checked = true;
    await w.saveItem(); await sleep(500);
    check('a stay marked paid is not offered for splitting',
          $('#esheet').style.display !== 'flex');
    if ($('#esheet').style.display === 'flex') w.closeExpense();
  }

  console.log('\n' + (fails ? fails + ' FAILED' : 'ALL PASSED') + '  (' + total + ' checks)');
  stop();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('harness blew up:', e); process.exit(1); });
