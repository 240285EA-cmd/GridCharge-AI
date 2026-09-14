import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BatteryCharging, CalendarCheck, Car, Clock3, Compass, Gauge, MapPin, Navigation, Play, Pause, Square, ShieldCheck, Zap, LocateFixed, AlertTriangle, PlusCircle, RefreshCw, Layers, UserCheck} from 'lucide-react';
import {MapContainer, Marker, Popup, TileLayer, Polyline, useMap} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import './styles.css';

const API = 'https://gridcharge-ai-backend.onrender.com/api';
const LOCAL_API = 'http://127.0.0.1:8010/api';
const STATION_LOCATION = { lat: 13.0827, lng: 80.2707 };
const DEFAULT_USER_LOC = { lat: 13.0400, lng: 80.2300 };

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

// Custom Leaflet Icons
const stationIcon = L.divIcon({
  className: 'station-pin',
  html: `<div class="station-pin-inner">⚡</div>`,
  iconSize: [36, 36],
  iconAnchor: [18, 18],
});

const userIcon = L.divIcon({
  className: 'user-dot',
  html: `<div class="user-dot-pulse"></div><div class="user-dot-inner"></div>`,
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

const destIcon = L.divIcon({
  className: 'station-pin',
  html: `<div class="station-pin-inner" style="background: linear-gradient(135deg, #ff6b6b, #c92a2a);">🏁</div>`,
  iconSize: [36, 36],
  iconAnchor: [18, 18],
});

type State = any;
const initial: any = {
  metrics: { load: 292, capacity: 500, solar: 48, health: 'NORMAL', utilization: 58, price: 10.96, thd: 2.1, predicted: 315, queue: 3 },
  chargers: [],
  queue: [],
  reservations: [],
  registered_evs: [
    { id: 'EV-REG-001', model: 'Tesla Model 3 Long Range', battery_capacity: 75, max_power: 120, connector: 'CCS2', protocol: 'Ultra-Fast' },
    { id: 'EV-REG-002', model: 'Hyundai Ioniq 5', battery_capacity: 72.6, max_power: 150, connector: 'CCS2', protocol: 'Ultra-Fast' },
    { id: 'EV-REG-003', model: 'Tata Nexon EV Max', battery_capacity: 40.5, max_power: 50, connector: 'Type 2', protocol: 'AC' }
  ],
  station_dashboard: {
    total_ports: 24,
    available: 15,
    reserved: 3,
    charging: 6,
    fault: 0,
    out_of_service: 0,
    vehicles_at_station: 9,
    vehicles_arriving: 3,
    vehicles_leaving: 6
  },
  events: ['Agent observing demand, renewable supply, and departure constraints.'],
  anomalies: [],
  available: 15
};

const fmt = (v: string) => {
  if (!v) return '';
  const [h, m] = v.split(':').map(Number);
  return `${((h + 11) % 12 + 1)}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

function getDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return (R * c).toFixed(1);
}

function MapViewController({ center, follow }: { center: [number, number]; follow: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (follow && center) {
      map.panTo(center, { animate: true });
    }
  }, [center, follow, map]);
  return null;
}

function App() {
  const [mode, setMode] = useState<'customer' | 'operator'>('customer');
  const [tab, setTab] = useState('Home');
  const [data, setData] = useState<State>(initial);
  const [activeApi, setActiveApi] = useState<string>(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? LOCAL_API : API);

  const [booking, setBooking] = useState<any>({
    model: 'Tesla Model 3 Long Range',
    battery_capacity: 75,
    current_soc: 20,
    target_soc: 85,
    connector: 'CCS2',
    protocol: 'Ultra-Fast',
    max_power: 120,
    station: 'GridCharge Central',
    destination: 'Chennai Airport',
    arrival: '18:30',
    departure: '19:30'
  });
  const [rec, setRec] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const [compatError, setCompatError] = useState<{ message: string; availableConnectors?: string[] } | null>(null);
  const [timeStr, setTimeStr] = useState('');
  const [tzName, setTzName] = useState('');

  // Clock & Timezone
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTimeStr(now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
      setTzName(tz);
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const fetchState = async (baseUrl: string = activeApi) => {
    try {
      const res = await fetch(`${baseUrl}/state`);
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (e) {
      console.warn('Backend polling error:', e);
    }
  };

  // WebSocket & REST polling fallback
  useEffect(() => {
    let ws: WebSocket | null = null;
    let pollInterval: any = null;

    // Initial state fetch
    fetchState(activeApi);

    const startPolling = () => {
      fetchState(activeApi);
      if (!pollInterval) {
        pollInterval = setInterval(() => {
          fetchState(activeApi);
        }, 4000);
      }
    };

    try {
      const wsUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
        ? 'ws://127.0.0.1:8010/ws/live' 
        : 'wss://gridcharge-ai-backend.onrender.com/ws/live';
      
      ws = new WebSocket(wsUrl);
      ws.onmessage = e => setData(JSON.parse(e.data));
      ws.onerror = () => {
        startPolling();
      };
      ws.onclose = () => {
        startPolling();
      };
    } catch {
      startPolling();
    }
    return () => { 
      if (ws) ws.close(); 
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [activeApi]);

  const energy = useMemo(() => Math.max(0, booking.battery_capacity * (booking.target_soc - booking.current_soc) / 100).toFixed(1), [booking]);
  const change = (k: string, v: any) => {
    setBooking((b: any) => ({ ...b, [k]: v }));
    setCompatError(null);
  };

  // EV Registration handler
  const handleRegisterEV = async (newEv: any) => {
    try {
      const res = await fetch(`${activeApi}/evs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newEv)
      });
      if (res.ok) {
        const saved = await res.json();
        setNotice(`Registered new EV: ${saved.model}`);
        fetchState();
      } else {
        const err = await res.json();
        setNotice(`Registration error: ${err.detail || 'Failed to register EV'}`);
      }
    } catch {
      setNotice('Registered EV locally.');
    }
  };

  // Recommend handler with strict compatibility check
  const recommend = async () => {
    setCompatError(null);
    setRec(null);
    try {
      const r = await fetch(`${activeApi}/recommendation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(booking)
      });
      const d = await r.json();
      if (r.ok) {
        setRec(d);
      } else {
        if (r.status === 422 || r.status === 409) {
          const detailMsg = d.detail || 'Incompatible connector selected.';
          let availConn: string[] = [];
          if (detailMsg.includes('Available compatible connectors:')) {
            const parts = detailMsg.split('Available compatible connectors:');
            if (parts[1]) availConn = parts[1].split(',').map((s: string) => s.trim());
          }
          setCompatError({
            message: detailMsg,
            availableConnectors: availConn.length ? availConn : ['Type 2', 'CHAdeMO']
          });
        } else {
          setNotice(d.detail || 'Please review your EV information.');
        }
      }
    } catch (e) {
      setNotice('Network error while checking recommendation.');
    }
  };

  // Reserve handler
  const reserve = async () => {
    try {
      const r = await fetch(`${activeApi}/reservations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...booking, arrival: rec?.arrival || booking.arrival })
      });
      const d = await r.json();
      if (r.ok) {
        setNotice(`Reservation ${d.id} confirmed — ${d.charger} is reserved.`);
        setTab('My Reservations');
        fetchState();
      } else {
        setNotice(d.detail || 'Reservation failed.');
      }
    } catch (e) {
      setNotice('Failed to communicate with reservation server.');
    }
  };

  // Handle Reservation Actions (Arriving, Start Charging, Complete, Cancel)
  const handleReservationAction = async (id: string, action: string) => {
    try {
      const res = await fetch(`${activeApi}/reservations/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      if (res.ok) {
        setNotice(`Reservation ${id} updated to ${action.toUpperCase()}`);
        fetchState();
      }
    } catch (e) {
      setNotice('Failed to update reservation.');
    }
  };

  const customerNav = ['Home', 'Live Map', 'Stations', 'Register EV', 'Book', 'My Reservations'];
  const operatorNav = ['Control Center'];

  return (
    <main>
      <header>
        <div className="brand"><Zap /> GridCharge <b>AI</b></div>

        {/* Mode Switcher */}
        <div className="mode-switch">
          <button
            className={mode === 'customer' ? 'active' : ''}
            onClick={() => { setMode('customer'); setTab('Home'); }}
          >
            CUSTOMER APP
          </button>
          <button
            className={mode === 'operator' ? 'active' : ''}
            onClick={() => { setMode('operator'); setTab('Control Center'); }}
          >
            CONTROL CENTER
          </button>
        </div>

        <nav>
          {mode === 'customer' ? (
            customerNav.map(n => (
              <button className={tab === n ? 'active' : ''} onClick={() => setTab(n)} key={n}>{n}</button>
            ))
          ) : (
            operatorNav.map(n => (
              <button className={tab === n ? 'active' : ''} onClick={() => setTab(n)} key={n}>{n}</button>
            ))
          )}
        </nav>

        <div className="header-right">
          <div className="tz-badge">
            <span>🌐 {tzName}</span>
            <span className="tz-time">{timeStr}</span>
          </div>
          <span className="live">● LIVE DIGITAL TWIN</span>
        </div>
      </header>

      {notice && <div className="notice">{notice}<button onClick={() => setNotice('')}>×</button></div>}

      {mode === 'customer' && (
        <>
          {tab === 'Home' && <Home go={setTab} data={data} />}
          {tab === 'Live Map' && <LiveMapTab data={data} booking={booking} change={change} />}
          {tab === 'Stations' && <Stations data={data} go={setTab} booking={booking} change={change} />}
          {tab === 'Register EV' && <RegisterEV onRegister={handleRegisterEV} evs={data.registered_evs} onSelectEV={(ev: any) => { setBooking((b: any) => ({ ...b, model: ev.model, battery_capacity: ev.battery_capacity, max_power: ev.max_power, connector: ev.connector, protocol: ev.protocol })); setTab('Book'); }} />}
          {tab === 'Book' && <Book data={data} b={booking} change={change} energy={energy} rec={rec} recommend={recommend} reserve={reserve} compatError={compatError} registeredEvs={data.registered_evs} />}
          {tab === 'My Reservations' && <Reservations data={data} action={handleReservationAction} onRefresh={fetchState} />}
        </>
      )}

      {mode === 'operator' && (
        <Admin data={data} scenario={async (s: string) => { await fetch(`${activeApi}/scenario/${s}`, { method: 'POST' }); fetchState(); }} />
      )}
    </main>
  );
}

function LiveMapTab({ data, booking, change }: any) {
  return (
    <section className="page">
      <p className="eyebrow">REAL-TIME MAP & NAVIGATION</p>
      <h2>Live EV Navigation & Station Status</h2>
      <LiveMap data={data} booking={booking} change={change} />
    </section>
  );
}

function LiveMap({ data, booking, change }: { data: any; booking: any; change: any }) {
  const [userPos, setUserPos] = useState<[number, number]>([DEFAULT_USER_LOC.lat, DEFAULT_USER_LOC.lng]);
  const [follow, setFollow] = useState(false);
  const [destName, setDestName] = useState(booking?.destination || '');
  const [destCoords, setDestCoords] = useState<[number, number] | null>(null);
  const [routePolyline, setRoutePolyline] = useState<[number, number][]>([]);
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | null>(null);
  const [geoNotice, setGeoNotice] = useState<string>('');

  const [demoActive, setDemoActive] = useState(false);
  const [demoPaused, setDemoPaused] = useState(false);
  const demoIntervalRef = useRef<any>(null);
  const demoIndexRef = useRef<number>(0);

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGeoNotice('Geolocation API not supported. Using Demo location.');
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (!demoActive) {
          setUserPos([pos.coords.latitude, pos.coords.longitude]);
          setGeoNotice('');
        }
      },
      (err) => {
        console.warn('Geolocation warning:', err.message);
        setGeoNotice('GPS access denied or unavailable. Demo location active.');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [demoActive]);

  const handleRecenter = () => {
    setFollow(true);
  };

  const handleSearchDest = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!destName.trim()) return;

    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(destName)}`);
      const results = await res.json();
      if (results && results.length > 0) {
        const lat = parseFloat(results[0].lat);
        const lon = parseFloat(results[0].lon);
        const coords: [number, number] = [lat, lon];
        setDestCoords(coords);
        change('destination', destName);
        fetchRoute(userPos, coords);
      } else {
        setGeoNotice(`Location "${destName}" not found. Showing route to GridCharge Central.`);
        setDestCoords([STATION_LOCATION.lat, STATION_LOCATION.lng]);
        fetchRoute(userPos, [STATION_LOCATION.lat, STATION_LOCATION.lng]);
      }
    } catch (err) {
      console.error('Geocoding error:', err);
      setDestCoords([STATION_LOCATION.lat, STATION_LOCATION.lng]);
      fetchRoute(userPos, [STATION_LOCATION.lat, STATION_LOCATION.lng]);
    }
  };

  const fetchRoute = async (start: [number, number], end: [number, number]) => {
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${start[1]},${start[0]};${end[1]},${end[0]}?overview=full&geometries=geojson`;
      const res = await fetch(url);
      const json = await res.json();

      if (json.routes && json.routes.length > 0) {
        const route = json.routes[0];
        const coordinates: [number, number][] = route.geometry.coordinates.map((c: [number, number]) => [c[1], c[0]]);
        setRoutePolyline(coordinates);
        const distKm = (route.distance / 1000).toFixed(1);
        const durMin = Math.round(route.duration / 60);
        setRouteInfo({ distance: `${distKm} km`, duration: `${durMin} min` });
      } else {
        setRoutePolyline([start, end]);
        const dist = getDistance(start[0], start[1], end[0], end[1]);
        setRouteInfo({ distance: `${dist} km`, duration: `${Math.round(+dist * 2)} min` });
      }
    } catch (err) {
      setRoutePolyline([start, end]);
      const dist = getDistance(start[0], start[1], end[0], end[1]);
      setRouteInfo({ distance: `${dist} km`, duration: `${Math.round(+dist * 2)} min` });
    }
  };

  useEffect(() => {
    fetchRoute(userPos, [STATION_LOCATION.lat, STATION_LOCATION.lng]);
  }, []);

  const startDemoDrive = () => {
    let path = routePolyline;
    if (!path || path.length < 2) {
      path = [userPos, [STATION_LOCATION.lat, STATION_LOCATION.lng]];
    }

    setDemoActive(true);
    setDemoPaused(false);
    setFollow(true);
    demoIndexRef.current = 0;

    if (demoIntervalRef.current) clearInterval(demoIntervalRef.current);

    demoIntervalRef.current = setInterval(() => {
      if (demoIndexRef.current < path.length) {
        setUserPos(path[demoIndexRef.current]);
        demoIndexRef.current += 1;
      } else {
        clearInterval(demoIntervalRef.current);
        setDemoActive(false);
        setDemoPaused(false);
      }
    }, 800);
  };

  const pauseDemoDrive = () => {
    if (demoIntervalRef.current) clearInterval(demoIntervalRef.current);
    setDemoPaused(true);
  };

  const resumeDemoDrive = () => {
    setDemoPaused(false);
    let path = routePolyline;
    demoIntervalRef.current = setInterval(() => {
      if (demoIndexRef.current < path.length) {
        setUserPos(path[demoIndexRef.current]);
        demoIndexRef.current += 1;
      } else {
        clearInterval(demoIntervalRef.current);
        setDemoActive(false);
        setDemoPaused(false);
      }
    }, 800);
  };

  const stopDemoDrive = () => {
    if (demoIntervalRef.current) clearInterval(demoIntervalRef.current);
    setDemoActive(false);
    setDemoPaused(false);
    demoIndexRef.current = 0;
  };

  return (
    <div className="live-map-wrapper">
      <form className="dest-bar" onSubmit={handleSearchDest}>
        <input
          type="text"
          className="dest-input"
          placeholder="Search destination or address (e.g., Chennai Airport, T. Nagar)..."
          value={destName}
          onChange={(e) => setDestName(e.target.value)}
        />
        <button type="submit" className="map-btn active">
          <Navigation size={15} /> Find & Route
        </button>
      </form>

      <div className="station-map">
        <MapContainer center={userPos} zoom={13} scrollWheelZoom={true} style={{ height: '350px', width: '100%' }}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MapViewController center={userPos} follow={follow} />

          <Marker position={[STATION_LOCATION.lat, STATION_LOCATION.lng]} icon={stationIcon}>
            <Popup className="map-popup">
              <strong>GridCharge Central</strong>
              <p>📍 Chennai Central Area</p>
              <p>⚡ Available Ports: <b>{data.available} / 24</b></p>
              <p>🛡️ Grid Health: <b>{data.metrics?.health || 'NORMAL'}</b></p>
              <p>⏱️ Expected Wait: <b>~{data.metrics?.queue * 2 || 4} min</b></p>
            </Popup>
          </Marker>

          <Marker position={userPos} icon={userIcon}>
            <Popup className="map-popup">
              <strong>{demoActive ? '🚗 EV in Motion (Demo Drive)' : '📍 Your Current Location'}</strong>
              <p>Lat: {userPos[0].toFixed(4)}, Lng: {userPos[1].toFixed(4)}</p>
            </Popup>
          </Marker>

          {destCoords && (
            <Marker position={destCoords} icon={destIcon}>
              <Popup className="map-popup">
                <strong>🏁 Destination: {destName || 'Selected Location'}</strong>
              </Popup>
            </Marker>
          )}

          {routePolyline.length > 0 && (
            <Polyline positions={routePolyline} color="#4ee8a8" weight={5} opacity={0.85} dashArray="8, 8" />
          )}
        </MapContainer>
      </div>

      {geoNotice && (
        <div className="map-notice">
          <span>ℹ️ {geoNotice}</span>
          <button onClick={() => setGeoNotice('')}>×</button>
        </div>
      )}

      <div className="map-controls">
        <div className="map-controls-left">
          <button className={`map-btn ${follow ? 'active' : ''}`} onClick={handleRecenter}>
            <LocateFixed size={15} /> My Location
          </button>
          <button className={`map-btn ${follow ? 'active' : ''}`} onClick={() => setFollow(!follow)}>
            <Compass size={15} /> {follow ? 'Following Vehicle' : 'Free Camera'}
          </button>
        </div>

        <div className="map-controls-right">
          {!demoActive ? (
            <button className="map-btn demo" onClick={startDemoDrive}>
              <Play size={15} /> Start Demo Drive
            </button>
          ) : demoPaused ? (
            <button className="map-btn demo" onClick={resumeDemoDrive}>
              <Play size={15} /> Resume Drive
            </button>
          ) : (
            <button className="map-btn" onClick={pauseDemoDrive}>
              <Pause size={15} /> Pause Drive
            </button>
          )}

          {demoActive && (
            <button className="map-btn stop" onClick={stopDemoDrive}>
              <Square size={15} /> Stop Drive
            </button>
          )}
        </div>
      </div>

      {routeInfo && (
        <div className="map-route-info">
          <span>🛣️ Distance: <b>{routeInfo.distance}</b></span>
          <span>⏱️ ETA: <b>{routeInfo.duration}</b></span>
          {demoActive && <span className="demo-badge">LIVE DEMO DRIVE ACTIVE</span>}
        </div>
      )}
    </div>
  );
}

function Home({ go, data }: any) {
  const dash = data.station_dashboard || {};
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">EV RESERVATION INTELLIGENCE</p>
          <h1>Charge smarter.<br /><em>Arrive ready.</em></h1>
          <p>Reserve the compatible charger that respects your trip deadline while GridCharge balances the station and grid.</p>
          <button className="primary" onClick={() => go('Book')}>Reserve a Charging Slot <CalendarCheck /></button>
        </div>
        <div className="hero-card">
          <span>GRIDCHARGE CENTRAL</span>
          <strong>{data.available} / 24</strong>
          <small>ports available now</small>
          <hr />
          <p><ShieldCheck /> {data.metrics?.health || 'NORMAL'} grid health</p>
          <p><Clock3 /> ~{data.metrics?.queue * 2 || 4} min expected wait</p>
        </div>
      </section>

      {/* Real-time Dashboard Summary Metrics */}
      <section className="page" style={{ paddingTop: 0 }}>
        <h3><Gauge /> Live Grid & Station Demand</h3>
        <div className="station-counts-grid">
          <div className="count-card">
            <small>Grid Demand</small>
            <b>{data.metrics?.load || 292} kW</b>
          </div>
          <div className="count-card">
            <small>Solar PV</small>
            <b>{data.metrics?.solar || 48} kW</b>
          </div>
          <div className="count-card">
            <small>Available Ports</small>
            <b>{dash.available ?? data.available ?? 15} / 24</b>
          </div>
          <div className="count-card">
            <small>Reserved Slots</small>
            <b>{dash.reserved ?? 3}</b>
          </div>
          <div className="count-card">
            <small>Currently Charging</small>
            <b>{dash.charging ?? 6} EVs</b>
          </div>
          <div className="count-card">
            <small>Waiting Queue</small>
            <b>{data.metrics?.queue || 3} EVs</b>
          </div>
        </div>
      </section>

      <section className="quick">
        <button onClick={() => go('Stations')}><MapPin /> Find charging station</button>
        <button onClick={() => go('Register EV')}><PlusCircle /> Register new EV</button>
        <button onClick={() => go('Book')}><BatteryCharging /> Plan the full stop</button>
        <button onClick={() => go('My Reservations')}><CalendarCheck /> View my reservations</button>
      </section>
    </>
  );
}

function RegisterEV({ onRegister, evs, onSelectEV }: any) {
  const [model, setModel] = useState('');
  const [battery, setBattery] = useState(60);
  const [maxPower, setMaxPower] = useState(100);
  const [connector, setConnector] = useState('CCS2');
  const [protocol, setProtocol] = useState('Ultra-Fast');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!model.trim()) return;
    onRegister({
      model,
      battery_capacity: +battery,
      max_power: +maxPower,
      connector,
      protocol
    });
    setModel('');
  };

  return (
    <section className="page">
      <p className="eyebrow">CUSTOMER VEHICLE MANAGEMENT</p>
      <h2>Register Your Electric Vehicle</h2>
      <div className="form-grid">
        <div className="card">
          <h3><Car /> Add EV Profile</h3>
          <form onSubmit={handleSubmit}>
            <label>EV Model Name
              <input value={model} onChange={e => setModel(e.target.value)} placeholder="e.g. MG ZS EV, Tata Nexon EV" required />
            </label>
            <div className="twocol">
              <label>Battery Capacity (kWh)
                <input type="number" value={battery} onChange={e => setBattery(+e.target.value)} min={10} max={200} />
              </label>
              <label>Max Charge Power (kW)
                <input type="number" value={maxPower} onChange={e => setMaxPower(+e.target.value)} min={10} max={350} />
              </label>
            </div>
            <div className="twocol">
              <label>Connector Type
                <select value={connector} onChange={e => setConnector(e.target.value)}>
                  {['CCS2', 'Type 2', 'CHAdeMO', 'GB/T'].map(x => <option key={x}>{x}</option>)}
                </select>
              </label>
              <label>Protocol
                <select value={protocol} onChange={e => setProtocol(e.target.value)}>
                  {['AC', 'DC', 'Ultra-Fast'].map(x => <option key={x}>{x}</option>)}
                </select>
              </label>
            </div>
            <button type="submit" className="primary full" style={{ marginTop: '16px' }}>Save EV Profile <PlusCircle size={16} /></button>
          </form>
        </div>

        <div className="card">
          <h3><UserCheck /> Registered Vehicles</h3>
          {evs && evs.length > 0 ? (
            evs.map((ev: any, idx: number) => (
              <div className="ev-card" key={ev.id || idx}>
                <div>
                  <h4>{ev.model}</h4>
                  <p>{ev.connector} · {ev.protocol} · {ev.battery_capacity} kWh · {ev.max_power} kW</p>
                </div>
                <button className="secondary" onClick={() => onSelectEV(ev)}>Book Slot</button>
              </div>
            ))
          ) : (
            <p style={{ color: '#8fa89d' }}>No EVs registered yet. Add your vehicle above.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function Stations({ data, go, booking, change }: any) {
  const [filter, setFilter] = useState('All');
  const dash = data.station_dashboard || {};
  const chargers = filter === 'All' ? data.chargers : data.chargers.filter((c: any) => c.connector === filter);

  const handleSelectStation = () => {
    change('station', 'GridCharge Central');
    go('Book');
  };

  return (
    <section className="page">
      <p className="eyebrow">LIVE STATION DASHBOARD</p>
      <h2>GridCharge Charging Fleet & Availability</h2>

      <LiveMap data={data} booking={booking} change={change} />

      <article className="station" style={{ display: 'block', marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3>GridCharge Central <span className="badge">2.4 km · 13.0827, 80.2707</span></h3>
            <p>CCS2 · Type 2 · CHAdeMO · GB/T · AC/DC/Ultra-Fast</p>
          </div>
          <button className="primary" onClick={handleSelectStation}>Select Station for Booking</button>
        </div>

        {/* Real-time Detailed Station Port Breakdown */}
        <div className="station-counts-grid" style={{ marginTop: '16px' }}>
          <div className="count-card">
            <small>Total Ports</small>
            <b>{dash.total_ports || 24}</b>
          </div>
          <div className="count-card">
            <small>Available</small>
            <b style={{ color: '#4ee8a8' }}>{dash.available ?? data.available ?? 15}</b>
          </div>
          <div className="count-card">
            <small>Reserved</small>
            <b style={{ color: '#f3c94b' }}>{dash.reserved ?? 3}</b>
          </div>
          <div className="count-card">
            <small>Charging</small>
            <b style={{ color: '#4dafff' }}>{dash.charging ?? 6}</b>
          </div>
          <div className="count-card">
            <small>Fault</small>
            <b style={{ color: '#ff667d' }}>{dash.fault ?? 0}</b>
          </div>
          <div className="count-card">
            <small>Vehicles at Station</small>
            <b>{dash.vehicles_at_station ?? 9}</b>
          </div>
          <div className="count-card">
            <small>Arriving Soon</small>
            <b>{dash.vehicles_arriving ?? 3}</b>
          </div>
          <div className="count-card">
            <small>Leaving Soon</small>
            <b>{dash.vehicles_leaving ?? 6}</b>
          </div>
        </div>
      </article>

      <div className="filters">
        {['All', 'CCS2', 'Type 2', 'CHAdeMO', 'GB/T'].map(x => (
          <button key={x} onClick={() => setFilter(x)} className={filter === x ? 'selected' : ''}>{x}</button>
        ))}
      </div>

      <div className="charger-grid">
        {chargers.map((c: any) => (
          <div key={c.id} className={'port ' + c.status.toLowerCase().replace(' ', '-')}>
            <b>{c.id}</b>
            <span>{c.connector} · {c.power} kW</span>
            <small>{c.status} {c.ev && `· ${c.ev}`}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function Book({ data, b, change, energy, rec, recommend, reserve, compatError, registeredEvs }: any) {
  return (
    <section className="page booking">
      <p className="eyebrow">SMART RESERVATION</p>
      <h2>Plan Your Charging Stop</h2>
      <div className="form-grid">
        <div className="card">
          <h3><Car /> EV Information & Select Station</h3>

          <label>Select Station
            <select value={b.station || 'GridCharge Central'} onChange={e => change('station', e.target.value)}>
              <option value="GridCharge Central">GridCharge Central (Chennai Central)</option>
            </select>
          </label>

          {registeredEvs && registeredEvs.length > 0 && (
            <label>Select Saved EV Profile
              <select
                onChange={(e) => {
                  const selected = registeredEvs.find((x: any) => x.model === e.target.value);
                  if (selected) {
                    change('model', selected.model);
                    change('battery_capacity', selected.battery_capacity);
                    change('max_power', selected.max_power);
                    change('connector', selected.connector);
                    change('protocol', selected.protocol);
                  }
                }}
              >
                <option value="">-- Choose Registered EV --</option>
                {registeredEvs.map((ev: any) => (
                  <option key={ev.id || ev.model} value={ev.model}>{ev.model} ({ev.connector})</option>
                ))}
              </select>
            </label>
          )}

          <label>EV Model Name
            <input value={b.model} onChange={e => change('model', e.target.value)} />
          </label>

          <div className="twocol">
            <label>Battery Capacity (kWh)<input type="number" value={b.battery_capacity} onChange={e => change('battery_capacity', +e.target.value)} /></label>
            <label>Max Power (kW)<input type="number" value={b.max_power} onChange={e => change('max_power', +e.target.value)} /></label>
            <label>Current SOC (%)<input type="number" value={b.current_soc} onChange={e => change('current_soc', +e.target.value)} /></label>
            <label>Target SOC (%)<input type="number" value={b.target_soc} onChange={e => change('target_soc', +e.target.value)} /></label>
          </div>

          <div className="twocol">
            <label>Connector Type
              <select value={b.connector} onChange={e => change('connector', e.target.value)}>
                {['CCS2', 'Type 2', 'CHAdeMO', 'GB/T'].map(x => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label>Charging Protocol
              <select value={b.protocol} onChange={e => change('protocol', e.target.value)}>
                {['AC', 'DC', 'Ultra-Fast'].map(x => <option key={x}>{x}</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="card">
          <h3><MapPin /> Departure Requirement</h3>
          <label>Destination / Trip Purpose<input value={b.destination} onChange={e => change('destination', e.target.value)} /></label>
          <div className="twocol">
            <label>Planned Arrival<input type="time" value={b.arrival} onChange={e => change('arrival', e.target.value)} /></label>
            <label>Must Leave By<input type="time" value={b.departure} onChange={e => change('departure', e.target.value)} /></label>
          </div>
          <div className="calc">
            <span>Energy Required <b>{energy} kWh</b></span>
            <span>Station Grid <b>{data.metrics?.health || 'NORMAL'}</b></span>
          </div>

          <button className="primary full" onClick={recommend}>
            Find the Best Charging Time <Zap />
          </button>

          {/* Compatibility Error Banner */}
          {compatError && (
            <div className="compat-warning">
              <h4><AlertTriangle size={18} /> Incompatible Connector Mismatch</h4>
              <p>{compatError.message}</p>
              <p><b>Please switch your connector to one of the following compatible options:</b></p>
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                {compatError.availableConnectors?.map((conn: string) => (
                  <button
                    key={conn}
                    className="secondary"
                    style={{ background: '#4e141a', color: '#ffb3ba', borderColor: '#8b242e' }}
                    onClick={() => change('connector', conn)}
                  >
                    Switch to {conn}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {rec && <Recommendation r={rec} b={b} reserve={reserve} />}
    </section>
  );
}

function Recommendation({ r, b, reserve }: any) {
  return (
    <section className="recommend">
      <div>
        <p className="eyebrow">AI COMPATIBILITY & SLOT RECOMMENDATION</p>
        <h2>{r.risky ? 'Selected time may risk departure deadline.' : 'Optimal Departure-Safe Slot Allocated'}</h2>
        <p>Station: <b>{r.station}</b> · Compatible ports available: <b>{r.compatible}</b> · Traffic: <b>{r.traffic}</b></p>
        <div className="timeline">
          <span>ARRIVE <b>{fmt(r.arrival)}</b></span>
          <span>START <b>{fmt(r.start)}</b></span>
          <span>READY <b>{fmt(r.ready)}</b></span>
          <span>LEAVE <b>{fmt(b.departure)}</b></span>
        </div>
        <p className={r.can_complete ? 'success' : 'danger'}>
          {r.can_complete ? '✓ Charging will complete before your requested departure time' : '⚠ This time slot risks missing your departure deadline'}
        </p>
      </div>
      <aside>
        <b>Recommended Port Allocation</b>
        <h3>{r.charger?.id || 'Port Allocation'} · {r.charger?.connector || b.connector}</h3>
        <p>Port Max Power: <b>{r.charger?.power || 0} kW</b> · Protocol: <b>{r.charger?.protocol || b.protocol}</b></p>
        <p>Energy: <b>{r.energy} kWh</b> · Charge Time: <b>~{r.minutes} min</b> · Cost: <b>₹{r.cost}</b></p>
        <button className="primary full" disabled={!r.charger} onClick={reserve}>
          Reserve Slot Now <CalendarCheck />
        </button>
      </aside>
    </section>
  );
}

function Reservations({ data, action, onRefresh }: any) {
  return (
    <section className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <p className="eyebrow">MY RESERVATIONS</p>
          <h2>Active & Past Charging Plans</h2>
        </div>
        <button className="secondary" onClick={onRefresh} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <RefreshCw size={14} /> Refresh Reservations
        </button>
      </div>

      {data.reservations.length === 0 ? (
        <div className="empty">No reservation yet. Use Book to secure a compatible charger port.</div>
      ) : (
        data.reservations.map((r: any) => (
          <article className="reservation" key={r.id}>
            <div>
              <span className="badge">{r.status}</span>
              <h3>{r.id} · {r.station || 'GridCharge Central'}</h3>
              <p><b>{r.charger}</b> · {r.connector} · Arrival: {fmt(r.arrival)} · Ready: ~{r.minutes} min ({r.energy} kWh)</p>
              <p>Destination: {r.destination} · Must leave by: {fmt(r.departure)} · Estimated Cost: ₹{r.cost}</p>
            </div>
            <div className="actions">
              {r.status === 'RESERVED' && <button className="primary" onClick={() => action(r.id, 'arriving')}>I’m Arriving</button>}
              {r.status === 'ARRIVING' && <button className="primary" onClick={() => action(r.id, 'start')}>Start Charging</button>}
              {r.status === 'CHARGING' && <button className="primary" onClick={() => action(r.id, 'complete')}>Complete</button>}
              {['RESERVED', 'ARRIVING'].includes(r.status) && <button className="secondary" onClick={() => action(r.id, 'cancel')}>Cancel</button>}
            </div>
          </article>
        ))
      )}
    </section>
  );
}

function Admin({ data, scenario }: any) {
  let m = data.metrics || {};
  let dash = data.station_dashboard || {};
  return (
    <section className="page">
      <p className="eyebrow">OPERATOR CONTROL CENTER & DIGITAL TWIN</p>
      <h2>Grid Telemetry & Station Operations</h2>

      <div className="scenarios">
        {['Normal Day', '100 EV Surge', 'Grid Overload', 'High Harmonics', 'Solar Available', 'Charger Failure'].map(s => (
          <button key={s} className={data.scenario === s ? 'selected' : ''} onClick={() => scenario(s)}>{s}</button>
        ))}
      </div>

      <div className="kpis">
        {[
          ['Grid Load', `${m.load} kW`],
          ['Solar PV', `${m.solar} kW`],
          ['Predicted Peak', `${m.predicted} kW`],
          ['Available Ports', `${data.available}/24`],
          ['Waiting Queue', m.queue],
          ['Harmonics THD', `${m.thd}%`]
        ].map(([x, y]) => (
          <div className="kpi" key={x}>
            <small>{x}</small>
            <b>{y}</b>
          </div>
        ))}
      </div>

      <div className="admin-grid">
        <div className="card">
          <h3><Gauge /> Feeder Health: <span className={m.health === 'NORMAL' ? 'success' : 'danger'}>{m.health}</span></h3>
          <p>Utilization: <b>{m.utilization}%</b> · Price: <b>₹{m.price}/kWh</b> · Voltage: <b>{m.voltage}V</b> · Freq: <b>{m.frequency}Hz</b></p>
          <h3>AI Optimization Decisions</h3>
          {data.events?.map((x: string, i: number) => <p className="event" key={i}>{x}</p>)}
        </div>

        <div className="card">
          <h3>Active Reservations & Queue</h3>
          {data.reservations?.length ? data.reservations.map((r: any) => <p className="event" key={r.id}><b>{r.id}</b> · {r.charger} · {r.status} ({r.model})</p>) : <p>No active reservations.</p>}
          <h3>System Anomalies</h3>
          {data.anomalies?.length ? data.anomalies.map((a: any, i: number) => <p className="event danger" key={i}>{a.severity}: {a.message}</p>) : <p className="success">No active anomalies detected.</p>}
        </div>
      </div>

      <h3>Station Charger Fleet Operations</h3>
      <div className="charger-grid">
        {data.chargers?.map((c: any) => (
          <div key={c.id} className={'port ' + c.status.toLowerCase().replace(' ', '-')}>
            <b>{c.id}</b>
            <span>{c.connector} · {c.power} kW</span>
            <small>{c.status} {c.ev && `· ${c.ev}`}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

