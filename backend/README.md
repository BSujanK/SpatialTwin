# SpatialTwin backend

FastAPI service: telemetry simulator, QUBO simulated-annealing repair scheduler, autonomous agent loop, repair copilot. Contract: `docs/contracts/api.md` (v1.1).

## Run (one command)

```
cd backend
pip install -r requirements.txt
uvicorn app.main:app --port 8000
```

Configuration lives in `backend/.env` (copy `.env.example`; it is gitignored and loaded with python-dotenv, and real environment variables win):

| Variable | Purpose |
|---|---|
| `QUALCOMM_API_KEY` | Enables **Qualcomm Cloud AI 100** (OpenAI-compatible `POST {QUALCOMM_ENDPOINT}/chat/completions`, Bearer auth) |
| `QUALCOMM_ENDPOINT` | Default `https://aisuite.cirrascale.com/apis/v2` |
| `QUALCOMM_MODEL` | Default `Llama-3.3-70B` |
| `ANTHROPIC_API_KEY`, `COPILOT_MODEL` | Optional second provider |
| `SIM_SPEED` | Fault drift multiplier |

AI provider order: Qualcomm, then Anthropic, then scripted replies. An error or 8 s timeout falls through to the next provider (a failed provider is skipped for 30 s). `GET /api/health` shows which one is active. The AI is used for copilot replies and for a background one-sentence root-cause `diagnose` event after each fault. If the OpenAI-style call fails and Qualcomm's `imagine` SDK is installed, the SDK is tried as a fallback. Keys are never logged.

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
