from __future__ import annotations

import asyncio
import math
import random
import uuid
import sqlite3
import json
from datetime import datetime, timedelta
from typing import Literal

import os

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="GridCharge AI")

ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "https://240285EA-cmd.github.io",
]

app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["*"], allow_headers=["*"])

CONNECTORS = ["CCS2", "Type 2", "CHAdeMO", "GB/T"]
SCENARIOS = ["Normal Day", "100 EV Surge", "Grid Overload", "High Harmonics", "Solar Available", "Charger Failure"]
DB = "gridcharge.db"

def db_init():
    with sqlite3.connect(DB) as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)")

def db_save(reservation: dict):
    with sqlite3.connect(DB) as conn:
        conn.execute("INSERT OR REPLACE INTO reservations VALUES (?, ?, ?)", (reservation["id"], json.dumps(reservation), datetime.now().isoformat()))

class Booking(BaseModel):
    model: str = "Tesla Model 3 Long Range"
    battery_capacity: float = Field(75, gt=1)
    current_soc: float = Field(20, ge=0, le=100)
    target_soc: float = Field(85, ge=1, le=100)
    connector: str = "CCS2"
    protocol: Literal["AC", "DC", "Ultra-Fast"] = "Ultra-Fast"
    max_power: float = Field(120, gt=1)
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
        self.chargers = []
        for i in range(1, 25):
            connector = CONNECTORS[(i - 1) % len(CONNECTORS)]
            power = 120 if i <= 8 else 60 if i <= 16 else 22
            self.chargers.append({"id": f"Port {i:02d}", "connector": connector, "protocol": "Ultra-Fast" if power == 120 else "DC" if power == 60 else "AC", "power": power, "status": "AVAILABLE", "health": 98, "ev": None})
        for i in range(6):
            self.chargers[i]["status"] = "CHARGING"
            self.chargers[i]["ev"] = f"EV-{101+i}"
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
        return {"load": round(load, 1), "capacity": cap, "solar": round(solar, 1), "voltage": round(401 + math.sin(self.tick / 4) * 3, 1), "frequency": round(50 + math.sin(self.tick / 7) * .08, 2), "thd": round(thd, 1), "price": round(8.2 + utilization / 21, 2), "utilization": utilization, "health": health, "predicted": round(load + 23 + surge * .12, 1), "queue": 3 + surge // 20 + (2 if overload else 0)}

    def snapshot(self):
        m = self._metrics()
        available = sum(c["status"] == "AVAILABLE" for c in self.chargers)
        anomalies = []
        if m["thd"] > 6: anomalies.append({"severity": "HIGH", "component": "Grid harmonics", "message": "THD exceeds the safe operating threshold"})
        if m["utilization"] > 84: anomalies.append({"severity": "CRITICAL", "component": "Grid feeder", "message": "Predicted overload requires dynamic throttling"})
        if self.scenario == "Charger Failure": anomalies.append({"severity": "HIGH", "component": "Port 18", "message": "Charger fault isolated; compatible EVs reallocated"})
        queue = [{"id": f"EV-{203+i}", "soc": 16 + i * 8, "target": 80, "priority": "URGENT" if i == 0 else "STANDARD", "departure": "19:30", "status": "WAITING"} for i in range(m["queue"])]
        return {"metrics": m, "chargers": self.chargers, "queue": queue, "reservations": list(self.reservations.values()), "events": self.events[-8:], "anomalies": anomalies, "timestamp": datetime.now().isoformat(), "scenario": self.scenario, "available": available}

    def scenario_set(self, name: str):
        if name not in SCENARIOS: raise ValueError(name)
        self.scenario = name
        if name == "Charger Failure":
            self.chargers[17]["status"] = "FAULT"; self.chargers[17]["health"] = 15
        else:
            if self.chargers[17]["status"] == "FAULT": self.chargers[17].update(status="AVAILABLE", health=98)
        self.events.append(f"Digital Twin scenario changed to {name}. Agent recalculated queue and power allocation.")

    def recommend(self, b: Booking):
        energy = round(b.battery_capacity * (b.target_soc - b.current_soc) / 100, 1)
        if energy <= 0: raise HTTPException(422, "Target SOC must be greater than Current SOC")
        compatible = [c for c in self.chargers if c["connector"] == b.connector and c["status"] == "AVAILABLE" and c["health"] > 75 and c["power"] >= min(b.max_power, 22)]
        if not compatible: compatible = [c for c in self.chargers if c["connector"] == b.connector and c["status"] == "AVAILABLE"]
        m = self._metrics(); charger = compatible[0] if compatible else None
        effective = min(b.max_power, charger["power"] if charger else 60, 120)
        minutes = max(8, math.ceil(energy / effective * 60 / .92))
        selected_risky = self.scenario in ("100 EV Surge", "Grid Overload") or b.arrival in ("18:30", "19:00")
        wait = 18 if selected_risky else max(2, m["queue"] * 2)
        recommended_wait = 3 if selected_risky else wait
        recommended_arrival = "18:45" if selected_risky else b.arrival
        def tadd(hhmm, mins):
            h, mi = map(int, hhmm.split(":")); return f"{(h + (mi + mins)//60)%24:02d}:{(mi+mins)%60:02d}"
        start = tadd(recommended_arrival, recommended_wait); ready = tadd(start, minutes)
        return {"energy": energy, "minutes": minutes, "compatible": len(compatible), "charger": charger, "wait": recommended_wait, "arrival": recommended_arrival, "start": start, "ready": ready, "cost": round(energy * m["price"], 0), "risky": selected_risky, "can_complete": ready <= b.departure, "traffic": "HIGH" if selected_risky else "LOW", "alternatives": [{"time": recommended_arrival, "wait": recommended_wait, "ready": ready}, {"time": "19:00", "wait": 8, "ready": tadd("19:08", minutes)}]}

state = TwinState()
clients: list[WebSocket] = []

async def broadcast():
    dead=[]
    for client in clients:
        try: await client.send_json(state.snapshot())
        except Exception: dead.append(client)
    for c in dead:
        if c in clients: clients.remove(c)

async def simulation():
    while True:
        await asyncio.sleep(2); state.tick += 1
        if state.tick % 6 == 0: state.events.append("Agent decision: balanced charging power against predicted feeder load and departure priority.")
        await broadcast()

@app.on_event("startup")
async def startup():
    db_init()
    asyncio.create_task(simulation())

@app.get("/api/state")
async def get_state(): return state.snapshot()

@app.post("/api/scenario/{name}")
async def set_scenario(name: str):
    state.scenario_set(name); await broadcast(); return state.snapshot()

@app.post("/api/recommendation")
async def recommendation(b: Booking): return state.recommend(b)

@app.post("/api/reservations")
async def reserve(b: Booking):
    r = state.recommend(b); charger = r["charger"]
    if not charger: raise HTTPException(409, "No compatible charger is available for this reservation")
    rid = "GC-" + uuid.uuid4().hex[:6].upper()
    charger.update(status="RESERVED", ev="Pending arrival")
    record = {"id": rid, "station": "GridCharge Central", "charger": charger["id"], "connector": b.connector, "model": b.model, "arrival": r["arrival"], "departure": b.departure, "destination": b.destination, "energy": r["energy"], "minutes": r["minutes"], "cost": r["cost"], "status": "RESERVED", "created": datetime.now().isoformat()}
    state.reservations[rid] = record; state.events.append(f"Reservation {rid}: {charger['id']} reserved for {b.model}; departure constraint {b.departure} enforced.")
    db_save(record)
    await broadcast(); return record

@app.post("/api/reservations/{rid}")
async def reservation_action(rid: str, action: ReservationAction):
    r = state.reservations.get(rid)
    if not r: raise HTTPException(404, "Reservation not found")
    charger = next(c for c in state.chargers if c["id"] == r["charger"])
    status = {"arriving":"ARRIVING", "start":"CHARGING", "complete":"COMPLETED", "cancel":"CANCELLED"}[action.action]
    r["status"] = status
    if action.action == "arriving": charger.update(status="RESERVED", ev="Arriving")
    elif action.action == "start": charger.update(status="CHARGING", ev=r["model"])
    elif action.action in ("complete", "cancel"): charger.update(status="AVAILABLE", ev=None)
    state.events.append(f"Reservation {rid} transitioned to {status}; {charger['id']} synchronized.")
    db_save(r)
    await broadcast(); return r

@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept(); clients.append(websocket); await websocket.send_json(state.snapshot())
    try:
        while True: await websocket.receive_text()
    except WebSocketDisconnect:
        if websocket in clients: clients.remove(websocket)
