"""SpatialTwin backend: FastAPI app, REST + websocket telemetry."""
from __future__ import annotations

import asyncio
import contextlib
import os
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import scheduler
from .simulator import FAULTS, Simulator, now_iso

sim = Simulator(speed=float(os.getenv("SIM_SPEED", "1")))


schedule_state: dict = {"latest": scheduler.compute_schedule(sim.snapshot())}


def recompute_schedule() -> dict:
    schedule_state["latest"] = scheduler.compute_schedule(sim.snapshot())
    return schedule_state["latest"]


def compute_kpis() -> dict:
    ms = sim.snapshot()
    bad = [m for m in ms if m["status"] != "ok"]
    return {
        "active_faults": len(bad),
        "at_risk_usd_per_hour": sum(m["downtime_cost_per_hour"] for m in bad),
        "repairs_completed": 0,
        "avg_mttr_min": None,
        "downtime_cost_avoided_usd": 0,
        "technicians": [
            {"name": "Tech A", "status": "idle", "machine_id": None},
            {"name": "Tech B", "status": "idle", "machine_id": None},
        ],
    }


class Hub:
    """Websocket connections + broadcast."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()

    async def broadcast(self, msg: dict) -> None:
        for ws in list(self.clients):
            try:
                await ws.send_json(msg)
            except Exception:
                self.clients.discard(ws)


hub = Hub()


def telemetry_message() -> dict:
    return {"type": "telemetry", "ts": now_iso(), "machines": sim.snapshot(), "kpis": compute_kpis()}


async def _loop() -> None:
    while True:
        await asyncio.sleep(1.0)
        if sim.tick(1.0):  # any status change -> re-optimise
            recompute_schedule()
        await hub.broadcast(telemetry_message())


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_loop())
    yield
    task.cancel()


app = FastAPI(title="SpatialTwin", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class InjectRequest(BaseModel):
    machine_id: str
    code: str


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/machines")
def machines():
    return sim.snapshot()


@app.get("/api/machines/{machine_id}")
def machine(machine_id: str):
    m = sim.get(machine_id)
    if m is None:
        raise HTTPException(404, f"unknown machine {machine_id}")
    return m


@app.post("/api/demo/inject-fault")
async def inject_fault(req: InjectRequest):
    if sim.get(req.machine_id) is None:
        raise HTTPException(404, f"unknown machine {req.machine_id}")
    if req.code not in FAULTS:
        raise HTTPException(400, f"unknown fault code {req.code}; use one of {sorted(FAULTS)}")
    m = sim.inject_fault(req.machine_id, req.code)
    recompute_schedule()
    await hub.broadcast(telemetry_message())
    return m


@app.get("/api/schedule")
def get_schedule():
    return schedule_state["latest"]


@app.post("/api/schedule/recompute")
def post_schedule_recompute():
    return recompute_schedule()


@app.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket):
    await ws.accept()
    hub.clients.add(ws)
    try:
        await ws.send_json(telemetry_message())
        while True:
            await ws.receive_text()  # keep the connection open; ignore input
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)
