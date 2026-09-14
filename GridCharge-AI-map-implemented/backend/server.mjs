// Dependency-free local runtime for managed Windows hosts where pip's isolated
// wheel installer is blocked. It mirrors main.py's public REST/WebSocket API.
import http from 'node:http';
import crypto from 'node:crypto';

const connectors = ['CCS2', 'Type 2', 'CHAdeMO', 'GB/T'];
const state = {
  scenario: 'Normal Day',
  tick: 0,
  reservations: {},
  registered_evs: [
    { id: 'EV-REG-001', model: 'Tesla Model 3 Long Range', battery_capacity: 75, max_power: 120, connector: 'CCS2', protocol: 'Ultra-Fast' },
    { id: 'EV-REG-002', model: 'Hyundai Ioniq 5', battery_capacity: 72.6, max_power: 150, connector: 'CCS2', protocol: 'Ultra-Fast' },
    { id: 'EV-REG-003', model: 'Tata Nexon EV Max', battery_capacity: 40.5, max_power: 50, connector: 'Type 2', protocol: 'AC' }
  ],
  events: ['Agent observing demand, renewable supply, and departure constraints.'],
  chargers: Array.from({ length: 24 }, (_, i) => ({
    id: `Port ${String(i + 1).padStart(2, '0')}`,
    connector: connectors[i % 4],
    protocol: i < 8 ? 'Ultra-Fast' : i < 16 ? 'DC' : 'AC',
    power: i < 8 ? 120 : i < 16 ? 60 : 22,
    status: i < 6 ? 'CHARGING' : i < 9 ? 'RESERVED' : 'AVAILABLE',
    health: 98,
    ev: i < 6 ? `EV-${101 + i}` : i < 9 ? `EV-RES-${300 + i}` : null
  }))
};

const clients = new Set();

function metrics() {
  let surge = state.scenario === '100 EV Surge' ? 100 : 0,
    over = state.scenario === 'Grid Overload' ? 135 : 0,
    load = 292 + Math.sin(state.tick / 3) * 18 + surge + over,
    solar = state.scenario === 'Solar Available' ? 155 : Math.max(12, 48 + Math.sin(state.tick / 5) * 18),
    util = Math.min(99, Math.round(load / 5));
  return {
    load: +load.toFixed(1),
    capacity: 500,
    solar: +solar.toFixed(1),
    voltage: +(401 + Math.sin(state.tick / 4) * 3).toFixed(1),
    frequency: +(50 + Math.sin(state.tick / 7) * .08).toFixed(2),
    thd: state.scenario === 'High Harmonics' ? 8.8 : +(2.1 + Math.abs(Math.sin(state.tick / 6))).toFixed(1),
    price: +(8.2 + util / 21).toFixed(2),
    utilization: util,
    health: util >= 85 ? 'CRITICAL' : util >= 70 ? 'HIGH LOAD' : 'NORMAL',
    predicted: +(load + 23 + surge * .12).toFixed(1),
    queue: 3 + Math.floor(surge / 20) + (over ? 2 : 0)
  };
}

function snapshot() {
  let m = metrics(), anomalies = [];
  let available = state.chargers.filter(c => c.status === 'AVAILABLE').length;
  let reserved = state.chargers.filter(c => c.status === 'RESERVED').length;
  let charging = state.chargers.filter(c => c.status === 'CHARGING').length;
  let fault = state.chargers.filter(c => c.status === 'FAULT').length;
  let out_of_service = state.chargers.filter(c => c.status === 'OUT_OF_SERVICE').length;

  let resList = Object.values(state.reservations);
  let vehicles_at_station = charging + reserved;
  let vehicles_arriving = resList.filter(r => ['RESERVED', 'ARRIVING'].includes(r.status)).length;
  let vehicles_leaving = resList.filter(r => r.status === 'CHARGING').length;

  if (m.thd > 6) anomalies.push({ severity: 'HIGH', component: 'Grid harmonics', message: 'THD exceeds the safe operating threshold' });
  if (m.utilization > 84) anomalies.push({ severity: 'CRITICAL', component: 'Grid feeder', message: 'Predicted overload requires dynamic throttling' });
  if (state.scenario === 'Charger Failure') anomalies.push({ severity: 'HIGH', component: 'Port 18', message: 'Charger fault isolated; compatible EVs reallocated' });

  return {
    metrics: m,
    chargers: state.chargers,
    queue: Array.from({ length: m.queue }, (_, i) => ({ id: `EV-${203 + i}`, soc: 16 + i * 8, target: 80, priority: i === 0 ? 'URGENT' : 'STANDARD', departure: '19:30', status: 'WAITING' })),
    reservations: resList,
    registered_evs: state.registered_evs,
    station_dashboard: {
      name: 'GridCharge Central',
      location: 'Chennai Central (13.0827, 80.2707)',
      total_ports: state.chargers.length,
      available,
      reserved,
      charging,
      fault,
      out_of_service,
      vehicles_at_station,
      vehicles_arriving,
      vehicles_leaving
    },
    events: state.events.slice(-8),
    anomalies,
    timestamp: new Date().toISOString(),
    scenario: state.scenario,
    available
  };
}

function add(time, min) {
  let [h, m] = time.split(':').map(Number), n = h * 60 + m + min;
  return `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

function recommend(b) {
  let energy = +(b.battery_capacity * (b.target_soc - b.current_soc) / 100).toFixed(1);
  if (!(energy > 0)) throw new Error('Target SOC must be greater than Current SOC');
  
  let available_connectors = Array.from(new Set(state.chargers.filter(c => c.status === 'AVAILABLE').map(c => c.connector))).sort();
  let compatible = state.chargers.filter(c => c.connector === b.connector && c.status === 'AVAILABLE' && c.health > 75);
  
  if (!compatible.length) {
    let exists = state.chargers.some(c => c.connector === b.connector);
    if (!exists) {
      const err = new Error(`${b.connector} connector is not compatible with ${b.station || 'GridCharge Central'}. Available compatible connectors: ${available_connectors.join(', ')}`);
      err.statusCode = 422;
      throw err;
    } else {
      const err = new Error(`All ${b.connector} ports at ${b.station || 'GridCharge Central'} are currently occupied or reserved. Available ports: ${available_connectors.join(', ')}`);
      err.statusCode = 409;
      throw err;
    }
  }

  let charger = compatible[0], m = metrics(), power = Math.min(b.max_power, charger.power, 120), minutes = Math.max(8, Math.ceil(energy / power * 60 / .92)),
    risky = ['100 EV Surge', 'Grid Overload'].includes(state.scenario) || ['18:30', '19:00'].includes(b.arrival), wait = risky ? 3 : Math.max(2, m.queue * 2),
    arrival = risky ? '18:45' : b.arrival, start = add(arrival, wait), ready = add(start, minutes);
  return {
    station: b.station || 'GridCharge Central',
    energy,
    minutes,
    compatible: compatible.length,
    charger,
    wait,
    arrival,
    start,
    ready,
    cost: Math.round(energy * m.price),
    risky,
    can_complete: ready <= b.departure,
    traffic: risky ? 'HIGH' : 'LOW',
    alternatives: [{ time: arrival, wait, ready }, { time: '19:00', wait: 8, ready: add('19:08', minutes) }]
  };
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function broadcast() {
  let payload = Buffer.from(JSON.stringify(snapshot())), header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]), frame = Buffer.concat([header, payload]);
  for (let s of clients) {
    try { s.write(frame); } catch { clients.delete(s); }
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  let body = '';
  req.on('data', x => body += x);
  req.on('end', () => {
    try {
      let b = body ? JSON.parse(body) : {}, path = new URL(req.url, 'http://x').pathname;
      if (req.method === 'GET' && path === '/api/state') return send(res, 200, snapshot());
      if (req.method === 'GET' && path === '/api/evs') return send(res, 200, state.registered_evs);
      if (req.method === 'POST' && path === '/api/evs') {
        let ev = { id: b.id || `EV-REG-${crypto.randomBytes(2).toString('hex').toUpperCase()}`, model: b.model, battery_capacity: b.battery_capacity, max_power: b.max_power, connector: b.connector, protocol: b.protocol };
        state.registered_evs.push(ev);
        state.events.push(`Registered new EV model: ${b.model} (${b.connector}, ${b.battery_capacity} kWh).`);
        broadcast();
        return send(res, 200, ev);
      }
      if (req.method === 'POST' && path.startsWith('/api/scenario/')) {
        state.scenario = decodeURIComponent(path.split('/').pop());
        if (state.scenario === 'Charger Failure') state.chargers[17] = { ...state.chargers[17], status: 'FAULT', health: 15 };
        else if (state.chargers[17].status === 'FAULT') state.chargers[17] = { ...state.chargers[17], status: 'AVAILABLE', health: 98 };
        state.events.push(`Digital Twin scenario changed to ${state.scenario}. Agent recalculated queue and power allocation.`);
        broadcast();
        return send(res, 200, snapshot());
      }
      if (req.method === 'POST' && path === '/api/recommendation') return send(res, 200, recommend(b));
      if (req.method === 'POST' && path === '/api/reservations') {
        let r = recommend(b);
        if (!r.charger) return send(res, 409, { detail: 'No compatible charger is available for this reservation' });
        let id = `GC-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
          record = { id, station: b.station || 'GridCharge Central', charger: r.charger.id, connector: b.connector, model: b.model, arrival: r.arrival, departure: b.departure, destination: b.destination, energy: r.energy, minutes: r.minutes, cost: r.cost, status: 'RESERVED', created: new Date().toISOString() };
        Object.assign(r.charger, { status: 'RESERVED', ev: `Reserved: ${b.model}` });
        state.reservations[id] = record;
        state.events.push(`Reservation ${id}: ${r.charger.id} reserved for ${b.model}; departure constraint ${b.departure} enforced.`);
        broadcast();
        return send(res, 200, record);
      }
      if (req.method === 'POST' && path.startsWith('/api/reservations/')) {
        let id = path.split('/').pop(), r = state.reservations[id];
        if (!r) return send(res, 404, { detail: 'Reservation not found' });
        let c = state.chargers.find(x => x.id === r.charger), status = { arriving: 'ARRIVING', start: 'CHARGING', complete: 'COMPLETED', cancel: 'CANCELLED' }[b.action];
        r.status = status;
        if (c) {
          if (b.action === 'arriving') Object.assign(c, { status: 'RESERVED', ev: `Arriving: ${r.model}` });
          if (b.action === 'start') Object.assign(c, { status: 'CHARGING', ev: r.model });
          if (['complete', 'cancel'].includes(b.action)) Object.assign(c, { status: 'AVAILABLE', ev: null });
        }
        state.events.push(`Reservation ${id} transitioned to ${status}; ${r.charger} synchronized.`);
        broadcast();
        return send(res, 200, r);
      }
      send(res, 404, { detail: 'Not found' });
    } catch (e) {
      send(res, e.statusCode || 422, { detail: e.message });
    }
  });
});

server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws') return socket.destroy();
  let accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
  broadcast();
});

server.listen(8010, '127.0.0.1', () => console.log('GridCharge compatibility API listening on http://127.0.0.1:8010'));

setInterval(() => {
  state.tick++;
  if (state.tick % 6 === 0) state.events.push('Agent decision: balanced charging power against predicted feeder load and departure priority.');
  broadcast();
}, 2000);

