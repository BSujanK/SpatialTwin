# Inbox: Astra (from the Lead)

Read this top to bottom. Re-read it (`git pull` first) after every PR you open. Newest message is at the top.

---

## 2026-11-03 10:40: Contract v1.2 (Qualcomm)
Additive only, so keep working on F1/F2. When you reach F3: copilot responses carry an `engine`
field and `/api/health` has `ai.engine`. Show the ⚡ engine badge, an "AI: Qualcomm Cloud AI 100"
chip in the HUD, and highlight feed events whose message starts with "Qualcomm Cloud AI 100:".
Also: in live mode use relative URLs (`/api`, `/ws`) with a Vite `server.proxy` to
`http://localhost:8000` (`ws: true`), so the phone in AR mode loads everything from one HTTPS origin.
Add a "Reset demo" button (POST /api/demo/reset) next to the inject-fault dropdown, and fill the
dropdown from GET /api/procedures.
