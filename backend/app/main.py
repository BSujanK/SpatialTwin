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
from .agent import Agent
from .simulator import FAULTS, Simulator, now_iso

sim = Simulator(speed=float(os.getenv("SIM_SPEED", "1")))


agent = Agent(sim)


def recompute_schedule() -> dict:
    """Manual re-run of the annealer (no agent events)."""
    agent.schedule = scheduler.compute_schedule(sim.snapshot())
    return agent.schedule


def compute_kpis() -> dict:
    return agent.kpis()


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


def _bind_loop() -> None:
    """Push agent events to websocket clients as soon as they happen."""
    loop = asyncio.get_running_loop()
    agent.listeners.clear()
    agent.add_listener(lambda ev: loop.call_soon_threadsafe(
        lambda: loop.create_task(hub.broadcast({"type": "event", "event": ev}))))


async def _loop() -> None:
    _bind_loop()
    while True:
        await asyncio.sleep(1.0)
        agent.on_tick(sim.tick(1.0))
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
    _bind_loop()
    m = sim.inject_fault(req.machine_id, req.code)
    agent.on_inject(req.machine_id)
    await hub.broadcast(telemetry_message())
    return m


@app.get("/api/events")
def events(limit: int = 50):
    return agent.get_events(limit)


@app.get("/api/kpis")
def kpis():
    return agent.kpis()


@app.post("/api/demo/reset")
def demo_reset():
    """Extra (not in contract): restore the initial scenario for a fresh demo run."""
    sim.reset()
    agent.reset()
    return {"ok": True}


@app.get("/api/schedule")
def get_schedule():
    return agent.schedule


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
