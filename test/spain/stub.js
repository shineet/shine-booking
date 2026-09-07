// Stands in for /api/get-booking so the page can be driven before Supabase
// exists. Same request shape, same PostgREST-ish paths.
const http = require('http'), fs = require('fs'), path = require('path');
const PIN = process.env.STUB_PIN || '4321';
const TOKEN = 'stub-token';
let days = [
  { id:'d1', trip:'spain', date:'2026-10-10', city:'Madrid',    note:'', sort_index:0 },
  { id:'d2', trip:'spain', date:'2026-10-11', city:'Madrid',    note:'', sort_index:1 },
  { id:'d3', trip:'spain', date:'2026-10-12', city:'Madrid',    note:'', sort_index:2 },
  { id:'d4', trip:'spain', date:'2026-10-13', city:'Barcelona', note:'', sort_index:3 },
  { id:'d5', trip:'spain', date:'2026-10-14', city:'Barcelona', note:'', sort_index:4 },
  { id:'d6', trip:'spain', date:'2026-10-15', city:'Barcelona', note:'', sort_index:5 },
];
let items = [
  { id:'i1', trip:'spain', day_id:'d1', at_time:'11:40', title:'Land at Barajas', detail:'Iberia 6252. Two taxis to the hotel.', place:'Adolfo Suarez Madrid-Barajas Airport', category:'travel', booked:true,  author:'Shine', sort_index:0 },
  { id:'i2', trip:'spain', day_id:'d1', at_time:'20:00', title:'Dinner, Sobrino de Botin', detail:'Booked for 8. They hold the table 15 min.', place:'Sobrino de Botin, Madrid', category:'food', booked:true, author:'Priya', sort_index:0 },
  { id:'i3', trip:'spain', day_id:'d2', at_time:'09:30', title:'Prado Museum', detail:'Tickets not booked yet. Free after 6pm but very busy.', place:'Museo del Prado, Madrid', category:'plan', booked:false, author:'Anil', sort_index:0 },
  { id:'i4', trip:'spain', day_id:'d4', at_time:'', title:'Train to Barcelona', detail:'AVE from Atocha, about 2h 30. Nobody has booked this.', place:'Madrid Atocha station', category:'travel', booked:false, author:'Shine', sort_index:0 },
];
let people = [
  { id:'fam1', trip:'spain', name:'Shine & Nadia',   from_date:null,         to_date:null,         sort_index:0 },
  { id:'fam2', trip:'spain', name:'Manoj & Kavitha', from_date:null,         to_date:null,         sort_index:1 },
  { id:'fam3', trip:'spain', name:'Noumit & Meher',  from_date:null,         to_date:null,         sort_index:2 },
  { id:'fam4', trip:'spain', name:'Dev & Nithya',    from_date:'2026-10-13', to_date:'2026-10-15', sort_index:3 },
];
let config = [{ trip: 'spain', usd_per_eur: 1.22 }];
let expenses = [];
let nextId = 100;

const send = (res, code, body, type='application/json') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/get-booking') {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      let b = {}; try { b = JSON.parse(raw); } catch (e) {}
      if (b.action === 'trip_login') {
        return b.pin === PIN ? send(res, 200, { token: TOKEN }) : send(res, 401, { error: 'Wrong PIN.' });
      }
      if (b.action !== 'db') return send(res, 400, { error: 'Unknown action' });
      if (b.token !== TOKEN) return send(res, 401, { error: 'Unauthorized' });

      const p = String(b.path || ''), table = p.split(/[?/]/)[0], m = String(b.method || 'GET').toUpperCase();
      const TABLES = { trip_days: () => days, trip_items: () => items,
                       trip_people: () => people, trip_expenses: () => expenses,
                       trip_config: () => config };
      if (!TABLES[table]) return send(res, 403, { error: 'Table not allowed' });
      const idMatch = p.match(/[?&]id=eq\.([^&]+)/);
      const paidByMatch = p.match(/[?&]paid_by=eq\.([^&]+)/);
      const list = TABLES[table]();

      if (m === 'GET') {
        let out = list.slice();
        if (table === 'trip_days' || table === 'trip_people') out.sort((x, y) => x.sort_index - y.sort_index);
        else if (table === 'trip_items') out.sort((x, y) => (x.at_time || '~').localeCompare(y.at_time || '~'));
        return send(res, 200, out);
      }
      if (m === 'POST') {
        const row = Object.assign({ id: 'n' + (nextId++) }, b.body);
        list.push(row); return send(res, 201, [row]);
      }
      if (m === 'PATCH' && table === 'trip_config') {
        Object.assign(config[0], b.body); return send(res, 200, config);
      }
      if (m === 'PATCH' && idMatch) {
        const row = list.find(r => r.id === idMatch[1]);
        if (!row) return send(res, 404, []);
        Object.assign(row, b.body); return send(res, 200, [row]);
      }
      if (m === 'DELETE' && paidByMatch) {
        for (let k = list.length - 1; k >= 0; k--) if (list[k].paid_by === paidByMatch[1]) list.splice(k, 1);
        return send(res, 200, []);
      }
      if (m === 'DELETE' && idMatch) {
        const i = list.findIndex(r => r.id === idMatch[1]);
        if (i >= 0) list.splice(i, 1);
        return send(res, 200, []);
      }
      return send(res, 405, { error: 'nope' });
    });
    return;
  }
  const file = req.url === '/' || req.url.startsWith('/spain') ? 'spain.html' : req.url.slice(1);
  const full = path.join('/Users/shinethankappan/Projects/shine-booking', file);
  if (!fs.existsSync(full)) return send(res, 404, 'not found', 'text/plain');
  send(res, 200, fs.readFileSync(full, 'utf8'), 'text/html; charset=utf-8');
}).listen(8412, () => console.log('stub on http://localhost:8412'))
  .on('error', (e) => {
    // A stub left running from a previous run keeps its state, and the next run
    // then fails on data it did not create, which reads exactly like a bug in
    // the page. Refuse to start rather than let the harness talk to it.
    console.error('STUB COULD NOT START:', e.code, '- something is already on 8412');
    process.exit(1);
  });
