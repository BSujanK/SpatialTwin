# SpatialTwin frontend

Phase 2 adds an **Autonomous control** sidebar tab beside Repair priorities. Advise recommends, Approve waits for the operator, and Auto allows backend execution within its safety envelope. The selected mode changes only after the policy PUT is acknowledged. Action cards show backend setpoints, time-to-failure before/after, throughput cost, expected loss avoided, and the async rationale/engine when available. Proposed actions offer Approve/Reject; active actions offer Revert. Technician interlocks disable approval while repairing; the live backend remains authoritative for all safety checks. Disconnects disable writes, and failed requests keep the previous confirmed state with a refresh/retry message.

In mock mode, `control_actions.json` and `control_policy.json` seed an in-memory interaction preview: mode and action buttons round-trip without network access. Reloading resets that preview. It does not implement the backend control engine or send hardware commands. Live mode uses `/api/control/*` and `control` websocket frames; history is refreshed after reconnect and buffered frames override older snapshots. The Refresh button also reloads policy changes made by another operator. F9 adds the control effects to twin/HUD/feed visuals.

The repair schedule appears at the top of the sidebar. Each ranked item shows its machine, reason, repair minutes and technician; clicking selects the machine and its numbered scene badge. Savings use `savings_usd / baseline_cost` (zero when the baseline is zero). Re-optimize calls `POST /api/schedule/recompute`; mock mode reloads the shared schedule fixture. The subscription refreshes the queue on every `schedule`/`resolve` event and after websocket reconnects. Failed recomputations retain the last known queue and show a retry message.

Vite + TypeScript + three.js, with no UI framework. Requires Node.js 22.12+ (tested on Node 24).

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. The browser uses relative `/api` URLs and a websocket on the frontend origin. Vite proxies both to `http://localhost:8000` (`ws: true`), including in preview mode, so HTTPS AR can use one origin.

For the standalone mock demo, copy `.env.example` to `.env.local` before starting Vite. `VITE_USE_MOCK=true` loads the original fixtures from `../shared/mock/` and emits bounded sensor jitter every second. No backend or API key is needed. Set `VITE_USE_MOCK=false` (or remove the setting) for live mode; set `VITE_API_URL` to change Vite's backend proxy target. Restart Vite after env changes. For deployment, set the mock flag before building and configure the production web server to proxy `/api` and `/ws` to the backend.

```sh
npm run build
npm test
npm run preview
```

With the backend and live Vite server running, `npm run test:live` checks REST plus two successive websocket telemetry/KPI frames through the actual frontend subscription. To use a different frontend origin: `npm run test:live -- http://localhost:5174`.

Drag the factory to orbit, scroll to zoom, and click a machine, floating label, or asset row to inspect live readings. The asset list also supports keyboard selection. Reset view restores the camera. If WebGL is unavailable the asset list and telemetry remain usable.

The live data layer reads `/api/machines`, then consumes `/ws/telemetry`, including v1.1 event/KPI frames. It reconnects with bounded exponential backoff and detects stalled telemetry; the connection badge identifies disconnected data. Mock mode is explicit and never silently replaces a failed live connection.

Machine meshes expose named maintenance parts for subsequent copilot highlighting. The scene, data subscription, and rendering components are separate so F6/F3/F4/F5 can extend them without changing the shared contract.

The impact HUD shows live dollars at risk, avoided downtime cost, average MTTR, active faults, and technician assignments. The activity feed loads `/api/events?limit=50`, merges incoming websocket events without duplicates, and refreshes history on reconnect. Click a machine-related event or assigned technician to select that machine. Disconnected data is marked as stale; missing history shows an error rather than invented values. In mock mode, KPI/event/schedule data comes directly from the shared fixtures and failure countdowns decrease with elapsed demo time.

F3/F4 can import `highlightPart(machineId, partOrNull)` and `setRankBadges(queue)` from `src/scene.ts`, or call the same methods on a `FactoryScene`. Highlighting restores the original material on clear/change, supports reduced motion, and returns false for an unavailable part. Rank badges clear when the corresponding machine leaves the queue. Compact labels are anchored above each model and adjusted to avoid collisions and canvas edges.

`npm run test:impact -- http://localhost:5174` is an opt-in integration check against a **local disposable demo**. It resets the scenario, injects SPINDLE-VIB on CNC-01, verifies the autonomous event sequence, $34,000/hour exposure, four active faults and updated ranks, prints event/KPI latency, then resets the scenario again. No production service should be used for this check.

## AR mode on a phone (F5)

WebXR needs HTTPS. The `https` mode serves the app with a self-signed certificate and the same `/api` and `/ws` proxy.

1. Start the backend (see the root README) so `/api` and `/ws` answer.
2. In `frontend/`, run `npm run dev:https`.
3. On an Android phone with Chrome, on the same Wi-Fi as the laptop, open `https://<laptop-LAN-IP>:5173` and accept the certificate warning.
4. Tap **Enter AR**, move the phone until the teal reticle appears on a surface, then tap to place the twin. Tap again elsewhere to move it. Use **Stop AR** (top right) to return to the 3D view.

Where WebXR is unavailable (desktop, iOS, plain HTTP) a small notice replaces the button and the normal 3D view keeps working. The bottom-left **Demo controls** panel injects a fault (`POST /api/demo/inject-fault`) or resets the scenario (`POST /api/demo/reset`); it is disabled in mock mode.
