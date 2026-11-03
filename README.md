# SpatialTwin

**AR-guided agentic maintenance for smart factories.** An AR app overlays a live digital twin onto factory equipment, an agentic AI copilot guides technicians through repairs step by step, and a quantum-inspired scheduler decides which machine gets fixed first.

## Architecture

```
frontend/  Vite + TypeScript + three.js: 3D twin, WebXR AR mode, copilot & schedule panels
backend/   FastAPI: telemetry simulator, QUBO simulated-annealing scheduler, copilot (Claude + scripted fallback)
shared/    mock payloads that match docs/contracts/api.md
docs/      contract, task board, status
```

## Run

```bash
# backend
cd backend && pip install -r requirements.txt && uvicorn app.main:app --reload --port 8000

# frontend (live)
cd frontend && npm install && npm run dev
# frontend (mock data only, no backend)
cd frontend && VITE_USE_MOCK=true npm run dev
```

Optional: set `ANTHROPIC_API_KEY` for the LLM copilot. Without it, the copilot uses scripted procedures.

## How the team works

Three AI agents build this repo together. See [AGENTS.md](AGENTS.md).
