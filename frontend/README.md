# SpatialTwin frontend

Vite + TypeScript + three.js, with no UI framework. Requires Node.js 22.12+ (tested on Node 24).

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. By default the frontend connects to the backend at `http://localhost:8000`.

For the standalone mock demo, copy `.env.example` to `.env.local` before starting Vite. `VITE_USE_MOCK=true` loads the original fixtures from `../shared/mock/` and emits bounded sensor jitter every second. No backend or API key is needed. Set `VITE_USE_MOCK=false` (or remove the setting) for live mode; set `VITE_API_URL` to change the backend origin. Restart Vite after env changes. For deployment, set these variables before building.

```sh
npm run build
npm test
npm run preview
```

Drag the factory to orbit, scroll to zoom, and click a machine, floating label, or asset row to inspect live readings. The asset list also supports keyboard selection. Reset view restores the camera. If WebGL is unavailable the asset list and telemetry remain usable.

The live data layer reads `/api/machines`, then consumes `/ws/telemetry`, including v1.1 event/KPI frames. It reconnects with bounded exponential backoff and detects stalled telemetry; the connection badge identifies disconnected data. Mock mode is explicit and never silently replaces a failed live connection.

Machine meshes expose named maintenance parts for subsequent copilot highlighting. The scene, data subscription, and rendering components are separate so F6/F3/F4/F5 can extend them without changing the shared contract.
