# SpatialTwin frontend

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
