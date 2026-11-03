# TASKS: hackathon build (demo 13:00 IST, freeze 12:40)

Work top to bottom in your column, with one PR per task (B1+B2 may share a PR if both are small). The Lead reviews PRs within ~10 minutes.

## Claude-2: backend (`backend/`, Python 3.11+, FastAPI)

| ID | Task | Done when |
|---|---|---|
| **B1** | Scaffold FastAPI app + **telemetry simulator**. Five machines start in exactly the state shown in `shared/mock/machines.json`. Each second, sensors jitter realistically, faulted machines drift worse (temperature up, health down, floor 5), and `status` follows health (`>=75` ok, `>=45` warning, else fault). Implement `/api/health`, `/api/machines`, `/api/machines/{id}`, `/ws/telemetry`, `/api/demo/inject-fault`. CORS open. | `uvicorn app.main:app` runs; responses match the contract; pytest passes |
| **B2** | **Quantum-inspired scheduler** (`backend/app/scheduler.py`). Formulate repair ordering as a **QUBO**: binary x[m,s] = machine m in slot s; penalty terms enforce one slot per machine and one machine per slot; the objective minimises Σ priority_weight(m) × completion_time(slot). priority_weight = f(100-health, criticality, fault severity). Solve with **simulated annealing** in numpy (seeded, <300 ms). Also compute the greedy baseline (sort by health) cost for comparison. Assign technicians alternately A/B. Write a short reason string per machine. `/api/schedule`, `/api/schedule/recompute`. Recompute automatically when a machine's status changes. | Tests: valid permutation, optimized_cost <= baseline_cost on 3 seeded cases |
| **B3** | **Procedures + copilot**. `backend/app/procedures.py`: 5 procedures (BRG-OVERHEAT copied exactly from `shared/mock/procedure_BRG-OVERHEAT.json`, and 4–5 steps each for BELT-SLIP, HYD-LEAK, SPINDLE-VIB, JOINT-STALL), each with realistic parts and safety warnings. `/api/procedures/{code}`. `/api/copilot` follows the step logic in the contract. If `ANTHROPIC_API_KEY` is set, call Claude (official `anthropic` SDK, model from env `COPILOT_MODEL`, default `claude-haiku-5-5`, max_tokens ~200, 8 s timeout) with a system prompt containing the machine's live sensors, the fault and the current step, and set `source:"llm"`. On any error or with no key, use the scripted reply and `source:"scripted"`. **Step advancement is always decided by code, never by the LLM.** Finishing the last step marks the machine ok/health 95. | Copilot works end-to-end with and without the key |
| **B4** | `backend/README.md`, `requirements.txt`, and `.env.example`. Polish: realistic fault injection for all 5 codes. | One-command run documented |

## Astra: frontend (`frontend/`, Vite + TypeScript + three.js, no heavy frameworks)

| ID | Task | Done when |
|---|---|---|
| **F1** | Scaffold Vite + TS + three.js. **Data layer** `src/api.ts`: if `VITE_USE_MOCK=true`, load `shared/mock/*.json` and simulate small sensor jitter every 1 s; otherwise use the REST + `/ws/telemetry` from the contract (`VITE_API_URL`, default `http://localhost:8000`). Auto-reconnect the websocket. | `npm run dev` shows data in both modes |
| **F2** | **3D digital twin scene**. Build a low-poly factory floor plus the 5 machines from three.js primitives (no external model files), one recognisable shape per `type`. Each machine is a `Group` with **named child meshes for every Part** (`motor`, `belt`, `valve`, `bearing`, `panel`, `spindle`, `arm_joint`, `hydraulic_line`, whichever apply). Colour the status ring green/amber/red and pulse it on fault. Floating label (CSS2DRenderer) per machine shows name, health and the two most relevant sensors, live. OrbitControls. Click a machine to select it. | Looks good on the laptop screen; live values update |
| **F3** | **Copilot panel**. Selecting a faulted/warning machine opens a side panel: fault info, a "Start guided repair" button, the current step card (title, instruction, safety warning in a red box), "Done → next" button, a free-text question box and the chat history. Calls `/api/copilot`. **Highlight the step's `part`** on the 3D model (emissive glow + bouncing arrow). Use browser `speechSynthesis` to speak the reply (toggle). | Full BRG-OVERHEAT walkthrough works in mock and live mode |
| **F4** | **Schedule panel**. Shows the ranked queue: rank badge, machine, reason, est. minutes, technician. Show "Quantum-inspired optimizer: X% less weighted downtime vs greedy", computed from baseline/optimized cost. A "Re-optimize" button. Clicking an item selects that machine. Draw number badges (1, 2, 3) above the machines in the scene. | Updates when the schedule changes |
| **F5** | **AR mode**. Add an "Enter AR" button (three.js `ARButton`, WebXR `hit-test` + `dom-overlay`). The reticle places the whole twin (scaled ~0.15) on a real surface; the panels stay usable via the DOM overlay. Hide the button with "AR not supported, showing 3D view" when unavailable. Also add a demo control: "Inject fault" dropdown → `/api/demo/inject-fault`. | Works on Android Chrome over HTTPS (`vite --host` + `@vitejs/plugin-basic-ssl`) |

## Lead
| ID | Task |
|---|---|
| L1 | Repo scaffold, contract, mocks, rules ✅ |
| L2 | Review and merge PRs; keep STATUS.md current |
| L3 | Integration test at ~11:45: run both sides live, fix contract drift |
| L4 | Demo script + root README polish, code freeze 12:40 |
