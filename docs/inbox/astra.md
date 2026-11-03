# Inbox: Astra (from the Lead)

Read this top to bottom. Re-read it (`git pull` first) after every PR you open. Newest message is at the top.

---

## 2026-11-03 11:40: F4 merged (#13). Great work. Last task: F7 polish (small, ≤15 min)
Lead visual check: the queue, the savings line and the badges all look right, and the queue re-ranks live after an inject.
Branch `astra/F7-polish` from the latest main, one PR by **12:35** (hard stop; code freeze 12:40). Only `frontend/src/style.css` and `impact.ts`/`schedule*.ts` (Claude-2 is editing `scene.ts` for F3b, so don't touch it).
1. Dark-theme scrollbars (the queue and feed currently show bright white browser scrollbars): `scrollbar-color` + `::-webkit-scrollbar` styles.
2. In the schedule panel, make the savings line pop: a large green "$1,948 saved" plus a small "16.3% less expected downtime vs greedy · QUBO simulated annealing".
3. Animate the "$ at risk / hour" number when it changes (count up/down over ~600 ms) and briefly flash the HUD tile red on increase and green on decrease.
4. When "Downtime cost avoided" increases, pulse it green.

---

## 2026-11-03 11:10: Welcome back. Finish F6, then F4. (F3 and F5 were reassigned)
While you were out of credits: **F5 (AR mode + Inject/Reset demo controls + `npm run dev:https`) was built by the Lead and merged (PR #9)**, and **F3 (copilot panel) is assigned to Claude-2**. Don't build F3 or F5.

1. **Push F6 now** (your local branch `astra/F6-impact-hud`). First merge main into it: `git fetch origin && git merge origin/main`. Expect small conflicts in `frontend/src/main.ts` / `scene.ts` with lines marked `// F5`. **Keep both sides**: F5's `setupAR(...)`, `mountDemoControls(...)`, `onXRFrame` hook and `setAnimationLoop((time, frame) => …)` must survive. Also, F5's AR CSS (`src/xr.ts`) hides `.app-header`, `.sidebar` and `.scene-labels` in AR, so if you renamed those classes, update the selectors in xr.ts. Then `npm run build && npm test`, push, open the PR `F6: impact HUD + agent feed`, and print the URL.
2. Then **F4 (schedule panel)** on `astra/F4-schedule` from the latest main: ranked queue, "Quantum-inspired optimizer saves $X (Y%) vs greedy" from `savings_usd`/`baseline_cost`, a Re-optimize button, click to select, and `setRankBadges(queue)` in the scene. Refresh the schedule on every `schedule` event from the websocket.
3. Integration test at 11:45, code freeze 12:40. Keep PRs small and push early.

---

## 2026-11-03 10:50: PR #8 approved and merged. Start F6 now.
Great foundation: live proxy, mock mode, models and telemetry panel all work.
Branch `astra/F6-impact-hud` from the latest main. **Include these fixes in the F6 PR first:**
1. **Horizontal overflow (projector-critical):** at 1440×850 the page is wider than the viewport, so the left title ("…igital twin") and the right panel are clipped. Make the layout fit any width ≥1280 with no horizontal scroll (`overflow-x: hidden` on body plus a grid that uses `minmax(0,1fr)` and a fixed side panel width, about 360px).
2. **Overlapping labels:** CNC/Conveyor/Robot/Press labels overlap. Make them more compact (name + health on one line, one sensor line) and raise each label above its own machine so they don't collide at the default camera.
3. **Countdown:** show `predicted_failure_min` on the label as a red "fails in N min" (F2 requirement).
4. **Helpers for later tasks:** export `highlightPart(machineId, part | null)` (pulsing emissive glow + bouncing arrow over the named part mesh) and `setRankBadges(queue)` (1/2/3 badges above machines). F3 and F4 depend on them.
5. Complete `types.ts` with Schedule, ScheduleItem, ProcedureStep, CopilotRequest/Response (incl. `engine`).
6. Add a favicon (an inline SVG data URI is fine) to kill the console 404.

Then do F6 itself (impact HUD + agent activity feed), as described in docs/TASKS.md. Mock mode must also read `shared/mock/events.json` and `schedule.json`. Use a big red "$ at risk / hour" number, because it's the first thing judges see.
Order after F6: F3 → F4 → F5. Time check: M2 integration test is at 11:45.

---

## 2026-11-03 10:40: Contract v1.2 (Qualcomm)
Additive only, so keep working on F1/F2. When you reach F3: copilot responses carry an `engine`
field and `/api/health` has `ai.engine`. Show the ⚡ engine badge, an "AI: Qualcomm Cloud AI 100"
chip in the HUD, and highlight feed events whose message starts with "Qualcomm Cloud AI 100:".
Also: in live mode use relative URLs (`/api`, `/ws`) with a Vite `server.proxy` to
`http://localhost:8000` (`ws: true`), so the phone in AR mode loads everything from one HTTPS origin.
Add a "Reset demo" button (POST /api/demo/reset) next to the inject-fault dropdown, and fill the
dropdown from GET /api/procedures.
