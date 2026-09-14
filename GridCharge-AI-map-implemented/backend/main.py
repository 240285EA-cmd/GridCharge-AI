from __future__ import annotations

import asyncio
import math
import random
import uuid
import sqlite3
import json
import os
from datetime import datetime, timedelta
from typing import Literal

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="GridCharge AI")

ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "https://240285EA-cmd.github.io",
    "https://240285ea-cmd.github.io",
]
env_origin = os.getenv("FRONTEND_ORIGIN", "").strip()
if env_origin:
    ALLOWED_ORIGINS.extend([env_origin, env_origin.lower(), env_origin.rstrip("/"), env_origin.lower().rstrip("/")])

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(set(ALLOWED_ORIGINS)),
    allow_origin_regex=r"https://.*\.(github\.io|loca\.lt)",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CONNECTORS = ["CCS2", "Type 2", "CHAdeMO", "GB/T"]
SCENARIOS = ["Normal Day", "100 EV Surge", "Grid Overload", "High Harmonics", "Solar Available", "Charger Failure"]
DB = "gridcharge.db"

def db_init():
    with sqlite3.connect(DB) as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS registered_evs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)")

def db_save_reservation(reservation: dict):
    with sqlite3.connect(DB) as conn:
        conn.execute("INSERT OR REPLACE INTO reservations VALUES (?, ?, ?)", (reservation["id"], json.dumps(reservation), datetime.now().isoformat()))

def db_save_ev(ev: dict):
    with sqlite3.connect(DB) as conn:
        conn.execute("INSERT OR REPLACE INTO registered_evs VALUES (?, ?, ?)", (ev["id"], json.dumps(ev), datetime.now().isoformat()))

def db_load_evs():
    evs = []
    try:
        with sqlite3.connect(DB) as conn:
            rows = conn.execute("SELECT payload FROM registered_evs").fetchall()
            for r in rows:
                evs.append(json.loads(r[0]))
    except Exception:
        pass
    return evs

class EVRegistration(BaseModel):
    id: str | None = None
    model: str = Field(..., example="Tesla Model 3 Long Range")
    battery_capacity: float = Field(75, gt=1)
    max_power: float = Field(120, gt=1)
    connector: str = Field("CCS2", example="CCS2")
    protocol: Literal["AC", "DC", "Ultra-Fast"] = "Ultra-Fast"

class Booking(BaseModel):
    model: str = "Tesla Model 3 Long Range"
    battery_capacity: float = Field(75, gt=1)
    current_soc: float = Field(20, ge=0, le=100)
    target_soc: float = Field(85, ge=1, le=100)
    connector: str = "CCS2"
    protocol: Literal["AC", "DC", "Ultra-Fast"] = "Ultra-Fast"
    max_power: float = Field(120, gt=1)
    station: str = "GridCharge Central"
    destination: str = "Chennai Airport"
    arrival: str = "18:45"
    departure: str = "19:30"

class ReservationAction(BaseModel):
    action: Literal["arriving", "start", "complete", "cancel"]

class TwinState:
    def __init__(self):
        self.scenario = "Normal Day"
        self.tick = 0
        self.reservations: dict[str, dict] = {}
        self.registered_evs: list[dict] = [
            {
                "id": "EV-REG-001",
                "model": "Tesla Model 3 Long Range",
                "battery_capacity": 75,
                "max_power": 120,
                "connector": "CCS2",
                "protocol": "Ultra-Fast"
            },
            {
                "id": "EV-REG-002",
                "model": "Hyundai Ioniq 5",
                "battery_capacity": 72.6,
                "max_power": 150,
                "connector": "CCS2",
                "protocol": "Ultra-Fast"
            },
            {
                "id": "EV-REG-003",
                "model": "Tata Nexon EV Max",
                "battery_capacity": 40.5,
                "max_power": 50,
                "connector": "Type 2",
                "protocol": "AC"
            }
        ]
        self.chargers = []
        for i in range(1, 25):
            connector = CONNECTORS[(i - 1) % len(CONNECTORS)]
            power = 120 if i <= 8 else 60 if i <= 16 else 22
            self.chargers.append({
                "id": f"Port {i:02d}",
                "connector": connector,
                "protocol": "Ultra-Fast" if power == 120 else "DC" if power == 60 else "AC",
                "power": power,
                "status": "AVAILABLE",
                "health": 98,
                "ev": None
            })
        for i in range(6):
            self.chargers[i]["status"] = "CHARGING"
            self.chargers[i]["ev"] = f"EV-{101+i}"
        for i in range(6, 9):
            self.chargers[i]["status"] = "RESERVED"
            self.chargers[i]["ev"] = f"EV-RES-{300+i}"
        
        self.events = ["Agent observing demand, renewable supply, and departure constraints."]

    def _metrics(self):
        s = self.scenario
        surge = 100 if s == "100 EV Surge" else 0
        overload = 135 if s == "Grid Overload" else 0
        solar = 155 if s == "Solar Available" else max(12, 48 + math.sin(self.tick / 5) * 18)
        load = 292 + math.sin(self.tick / 3) * 18 + surge + overload
        thd = 8.8 if s == "High Harmonics" else 2.1 + abs(math.sin(self.tick / 6))
        cap = 500
        utilization = min(99, round(load / cap * 100))
        health = "CRITICAL" if utilization >= 85 else "HIGH LOAD" if utilization >= 70 else "NORMAL"
        return {
            "load": round(load, 1),
            "capacity": cap,
            "solar": round(solar, 1),
            "voltage": round(401 + math.sin(self.tick / 4) * 3, 1),
            "frequency": round(50 + math.sin(self.tick / 7) * .08, 2),
            "thd": round(thd, 1),
            "price": round(8.2 + utilization / 21, 2),
            "utilization": utilization,
            "health": health,
            "predicted": round(load + 23 + surge * .12, 1),
            "queue": 3 + surge // 20 + (2 if overload else 0)
        }

    def snapshot(self):
        m = self._metrics()
        total_ports = len(self.chargers)
        available = sum(c["status"] == "AVAILABLE" for c in self.chargers)
        reserved = sum(c["status"] == "RESERVED" for c in self.chargers)
        charging = sum(c["status"] == "CHARGING" for c in self.chargers)
        fault = sum(c["status"] == "FAULT" for c in self.chargers)
        out_of_service = sum(c["status"] == "OUT_OF_SERVICE" for c in self.chargers)

        vehicles_at_station = charging + reserved
        vehicles_arriving = sum(1 for r in self.reservations.values() if r.get("status") in ("RESERVED", "ARRIVING"))
        vehicles_leaving = sum(1 for r in self.reservations.values() if r.get("status") == "CHARGING")

        anomalies = []
        if m["thd"] > 6:
            anomalies.append({"severity": "HIGH", "component": "Grid harmonics", "message": "THD exceeds the safe operating threshold"})
        if m["utilization"] > 84:
            anomalies.append({"severity": "CRITICAL", "component": "Grid feeder", "message": "Predicted overload requires dynamic throttling"})
        if self.scenario == "Charger Failure":
            anomalies.append({"severity": "HIGH", "component": "Port 18", "message": "Charger fault isolated; compatible EVs reallocated"})
        
        queue = [{"id": f"EV-{203+i}", "soc": 16 + i * 8, "target": 80, "priority": "URGENT" if i == 0 else "STANDARD", "departure": "19:30", "status": "WAITING"} for i in range(m["queue"])]
        
        station_dashboard = {
            "name": "GridCharge Central",
            "location": "Chennai Central (13.0827, 80.2707)",
            "total_ports": total_ports,
            "available": available,
            "reserved": reserved,
            "charging": charging,
            "fault": fault,
            "out_of_service": out_of_service,
            "vehicles_at_station": vehicles_at_station,
            "vehicles_arriving": vehicles_arriving,
            "vehicles_leaving": vehicles_leaving
        }

        return {
            "metrics": m,
            "chargers": self.chargers,
            "queue": queue,
            "reservations": list(self.reservations.values()),
            "registered_evs": self.registered_evs,
            "station_dashboard": station_dashboard,
            "events": self.events[-8:],
            "anomalies": anomalies,
            "timestamp": datetime.now().isoformat(),
            "scenario": self.scenario,
            "available": available
        }

    def scenario_set(self, name: str):
        if name not in SCENARIOS:
            raise ValueError(name)
        self.scenario = name
        if name == "Charger Failure":
            self.chargers[17]["status"] = "FAULT"
            self.chargers[17]["health"] = 15
        else:
            if self.chargers[17]["status"] == "FAULT":
                self.chargers[17].update(status="AVAILABLE", health=98)
        self.events.append(f"Digital Twin scenario changed to {name}. Agent recalculated queue and power allocation.")

    def recommend(self, b: Booking):
        energy = round(b.battery_capacity * (b.target_soc - b.current_soc) / 100, 1)
        if energy <= 0:
            raise HTTPException(422, detail="Target SOC must be greater than Current SOC")
        
        # Check connector availability
        available_connectors = sorted(list(set(c["connector"] for c in self.chargers if c["status"] == "AVAILABLE")))
        
        # Find exact compatible ports (connector + status AVAILABLE + health > 75)
        compatible = [c for c in self.chargers if c["connector"] == b.connector and c["status"] == "AVAILABLE" and c["health"] > 75]
        
        if not compatible:
            # Check if any port with this connector exists at all or if none available
            ports_with_connector = [c for c in self.chargers if c["connector"] == b.connector]
            if not ports_with_connector:
                raise HTTPException(
                    status_code=422,
                    detail=f"{b.connector} connector is not compatible with {b.station}. Available compatible connectors: {', '.join(available_connectors)}"
                )
            else:
                raise HTTPException(
                    status_code=409,
                    detail=f"All {b.connector} ports at {b.station} are currently occupied or reserved. Available ports: {', '.join(available_connectors)}"
                )

        m = self._metrics()
        charger = compatible[0]
        effective = min(b.max_power, charger["power"], 120)
        minutes = max(8, math.ceil(energy / effective * 60 / .92))
        selected_risky = self.scenario in ("100 EV Surge", "Grid Overload") or b.arrival in ("18:30", "19:00")
        wait = 18 if selected_risky else max(2, m["queue"] * 2)
        recommended_wait = 3 if selected_risky else wait
        recommended_arrival = "18:45" if selected_risky else b.arrival

        def tadd(hhmm, mins):
            h, mi = map(int, hhmm.split(":"))
            return f"{(h + (mi + mins)//60)%24:02d}:{(mi+mins)%60:02d}"

        start = tadd(recommended_arrival, recommended_wait)
        ready = tadd(start, minutes)

        return {
            "station": b.station,
            "energy": energy,
            "minutes": minutes,
            "compatible": len(compatible),
            "charger": charger,
            "wait": recommended_wait,
            "arrival": recommended_arrival,
            "start": start,
            "ready": ready,
            "cost": round(energy * m["price"], 0),
            "risky": selected_risky,
            "can_complete": ready <= b.departure,
            "traffic": "HIGH" if selected_risky else "LOW",
            "alternatives": [
                {"time": recommended_arrival, "wait": recommended_wait, "ready": ready},
                {"time": "19:00", "wait": 8, "ready": tadd("19:08", minutes)}
            ]
        }

state = TwinState()
clients: list[WebSocket] = []

async def broadcast():
    dead = []
    for client in clients:
        try:
            await client.send_json(state.snapshot())
        except Exception:
            dead.append(client)
    for c in dead:
        if c in clients:
            clients.remove(c)

async def simulation():
    while True:
        await asyncio.sleep(2)
        state.tick += 1
        if state.tick % 6 == 0:
            state.events.append("Agent decision: balanced charging power against predicted feeder load and departure priority.")
        await broadcast()

@app.on_event("startup")
async def startup():
    db_init()
    # Load stored EVs
    db_evs = db_load_evs()
    if db_evs:
        state.registered_evs.extend([e for e in db_evs if e["id"] not in [x["id"] for x in state.registered_evs]])
    asyncio.create_task(simulation())

@app.get("/api/state")
async def get_state():
    return state.snapshot()

@app.get("/api/evs")
async def get_evs():
    return state.registered_evs

@app.post("/api/evs")
async def register_ev(ev: EVRegistration):
    ev_id = ev.id or f"EV-REG-{uuid.uuid4().hex[:4].upper()}"
    ev_record = {
        "id": ev_id,
        "model": ev.model,
        "battery_capacity": ev.battery_capacity,
        "max_power": ev.max_power,
        "connector": ev.connector,
        "protocol": ev.protocol
    }
    state.registered_evs.append(ev_record)
    db_save_ev(ev_record)
    state.events.append(f"Registered new EV model: {ev.model} ({ev.connector}, {ev.battery_capacity} kWh).")
    await broadcast()
    return ev_record

@app.post("/api/scenario/{name}")
async def set_scenario(name: str):
    state.scenario_set(name)
    await broadcast()
    return state.snapshot()

@app.post("/api/recommendation")
async def recommendation(b: Booking):
    return state.recommend(b)

@app.post("/api/reservations")
async def reserve(b: Booking):
    r = state.recommend(b)
    charger = r["charger"]
    if not charger:
        raise HTTPException(409, detail="No compatible charger is available for this reservation")
    
    rid = "GC-" + uuid.uuid4().hex[:6].upper()
    charger.update(status="RESERVED", ev=f"Reserved: {b.model}")
    
    record = {
        "id": rid,
        "station": b.station or "GridCharge Central",
        "charger": charger["id"],
        "connector": b.connector,
        "model": b.model,
        "arrival": r["arrival"],
        "departure": b.departure,
        "destination": b.destination,
        "energy": r["energy"],
        "minutes": r["minutes"],
        "cost": r["cost"],
        "status": "RESERVED",
        "created": datetime.now().isoformat()
    }
    state.reservations[rid] = record
    state.events.append(f"Reservation {rid}: {charger['id']} reserved for {b.model}; departure constraint {b.departure} enforced.")
    db_save_reservation(record)
    await broadcast()
    return record

@app.post("/api/reservations/{rid}")
async def reservation_action(rid: str, action: ReservationAction):
    r = state.reservations.get(rid)
    if not r:
        raise HTTPException(404, detail="Reservation not found")
    
    charger = next((c for c in state.chargers if c["id"] == r["charger"]), None)
    status = {"arriving": "ARRIVING", "start": "CHARGING", "complete": "COMPLETED", "cancel": "CANCELLED"}[action.action]
    r["status"] = status
    
    if charger:
        if action.action == "arriving":
            charger.update(status="RESERVED", ev=f"Arriving: {r['model']}")
        elif action.action == "start":
            charger.update(status="CHARGING", ev=r["model"])
        elif action.action in ("complete", "cancel"):
            charger.update(status="AVAILABLE", ev=None)
            
    state.events.append(f"Reservation {rid} transitioned to {status}; {r['charger']} synchronized.")
    db_save_reservation(r)
    await broadcast()
    return r

async def handle_ws(websocket: WebSocket):
    await websocket.accept()
    clients.append(websocket)
    await websocket.send_json(state.snapshot())
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        if websocket in clients:
            clients.remove(websocket)

@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await handle_ws(websocket)

@app.websocket("/ws/live")
async def ws_live_endpoint(websocket: WebSocket):
    await handle_ws(websocket)

