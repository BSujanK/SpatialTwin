# SpatialTwin backend

FastAPI service: telemetry simulator, QUBO simulated-annealing repair scheduler, autonomous agent loop, repair copilot. Contract: `docs/contracts/api.md` (v1.1).

## Run (one command)

```
cd backend
pip install -r requirements.txt
uvicorn app.main:app --port 8000
```

Optional environment variables (see `.env.example`; `.env` is not loaded automatically, so export them in your shell):
`ANTHROPIC_API_KEY`, `COPILOT_MODEL` (default `claude-haiku-5-5`), `SIM_SPEED`.
Without a key the copilot answers with scripted replies.

## Test

```
cd backend && pytest -q
```

## Demo

```
curl -X POST localhost:8000/api/demo/inject-fault -H "content-type: application/json" \
     -d '{"machine_id":"CNC-01","code":"SPINDLE-VIB"}'
curl localhost:8000/api/events
curl localhost:8000/api/kpis
curl -X POST localhost:8000/api/demo/reset      # back to the initial scenario
```

Fault codes: `BRG-OVERHEAT` (pump), `BELT-SLIP` (conveyor), `HYD-LEAK` (press), `SPINDLE-VIB` (CNC), `JOINT-STALL` (robot). Any code can be injected on any machine, and each has its own sensor drift and predicted time to failure.

## Layout

| File | What |
|---|---|
| `app/simulator.py` | 5 machines, sensor jitter, fault drift, health to status, trend-based `predicted_failure_min` |
| `app/scheduler.py` | QUBO (machine × technician-slot), seeded simulated annealing, greedy baseline, USD expected-loss objective |
| `app/agent.py` | detect → diagnose → schedule → dispatch → guide → resolve, event log, KPIs |
| `app/procedures.py` / `app/copilot.py` | 5 repair procedures; copilot with Claude and scripted fallback (code decides step advancement) |
| `app/main.py` | REST + `/ws/telemetry` |

The scheduler is "quantum-inspired": the QUBO could be sent to a quantum annealer, but today it is solved classically with simulated annealing.
