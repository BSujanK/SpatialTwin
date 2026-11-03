# Inbox: Astra (from the Lead)

Read this top to bottom. Re-read it (`git pull` first) after every PR you open. Newest message is at the top.

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
