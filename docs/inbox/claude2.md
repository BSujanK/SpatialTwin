# Inbox: Claude-2 (from the Lead)

Read this top to bottom and do every unchecked item in order. Re-read this file
(`git pull` first) after every PR you open. Newest message is at the top.

---

## 2026-11-03 11:25: B8 merged (#11). Keep going with F3, then B9 (small)
Lead live test with the real key: 4/4 copilot calls right after an inject returned `source:"llm"`. 44 tests pass.
**F3 stays your priority** (F6 is merged, so build on its helpers).

### B9 (after the F3 PR, ~10 min). Branch `claude2/B9-demo-realism`
1. **Inject must change the sensors immediately.** In the live test the LLM said "vibration 1.9 mm/s, which is above the limit", because SPINDLE-VIB was injected but the sensors were still healthy. On inject, jump the sensors to the fault signature (e.g. SPINDLE-VIB → vibration 9–12 mm/s, temperature +15 °C; BRG-OVERHEAT → temperature 90+ °C and vibration 10+; HYD-LEAK → pressure dropping, temperature up; BELT-SLIP → rpm −12% and vibration up; JOINT-STALL → temperature up and rpm 0), so the AI's answers match the live data.
2. **Latency cap for the copilot:** one live reply took 11.3 s. Give each copilot request a total budget of 6 s (including retry); past that, return the scripted reply. Root-cause calls can keep the longer budget.

---

## 2026-11-03 11:05: B7 + B6 approved and merged. Next: B8 (small) and then F3 (frontend)
Verified live on the real key: health shows Qualcomm Cloud AI 100 · Llama-3.3-70B, the copilot replies via Qualcomm, and the root-cause events are great. 38 tests pass.

### B8: LLM reliability during the demo (backend, ~15 min). Branch `claude2/B8-llm-reliability`
Lead live test: inject SPINDLE-VIB on CNC-01, copilot "start" → Qualcomm reply (5 s). The immediately following
question "what is the vibration right now?" came back `source:"scripted"`. Likely cause: the concurrent root-cause
calls (4 at startup + 1 per inject) tripped a failure, and the 30 s provider skip then disabled the copilot.
- Root-cause calls go through a single background worker (a queue, concurrency 1, newest-first, drop if older than 60 s), so they never compete with copilot calls.
- Copilot calls get priority: if a copilot request arrives, it doesn't wait behind root-cause work.
- Only connection errors and timeouts trigger the 30 s skip. On HTTP 429/5xx, retry once after 0.5 s; a root-cause failure must NEVER disable the copilot's provider.
- Warm-up: at startup, fire one tiny chat call in the background so the first live copilot reply is fast.
- Log (without the key) which provider answered and why a fallback happened, at INFO level.
- Verify with the real key: inject, then start + 3 questions in a row, and all 4 must be `source:"llm"`. Put that output in the PR.

### Then F3 (frontend), because Astra is out of credits
Astra hit its usage limit. Its F6 work is being pushed by its operator as `astra/F6-impact-hud`. **Wait until F6 is merged into main** (check `git log origin/main` for "F6"), then do **F3 (copilot panel)** from docs/TASKS.md in `frontend/`, using F6's helpers (`highlightPart`, `setRankBadges`, `types.ts`). Branch `claude2/F3-copilot`. `npm run build` and `npm test` must pass. You may edit frontend/ for this task.

- [ ] B8 PR opened
- [ ] F3 PR opened

---

## 2026-11-03 10:40: Qualcomm Cloud AI 100 (TOP PRIORITY)

The hackathon requires a Qualcomm kit. Our AI brain will run on **Qualcomm Cloud AI 100**.

### Step 1: sync
```
git checkout main && git pull
```

### Step 2: make sure the API key is on this machine (never in git)
Check whether `backend/.env` exists and contains a line starting `QUALCOMM_API_KEY=`.
**Do not print the file or the key**. Only check that the line exists, e.g.
`python -c "import re,pathlib;p=pathlib.Path('backend/.env');print(bool(p.exists() and re.search(r'^QUALCOMM_API_KEY=.+',p.read_text(),re.M)))"`

- If it prints `True`, go to Step 3.
- If it prints `False`, **open the key window for the human** in a new terminal window, so they can paste the key and endpoint there (hidden input, never in chat). Then wait:
  - Windows: `Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"$PWD\scripts\set-qualcomm-key.ps1"`
  - macOS: `open -a Terminal "$(pwd)/scripts/set-qualcomm-key.sh"`
  - Linux: ask the human to run `bash scripts/set-qualcomm-key.sh` in their own terminal.
  - Tell the human: "A window opened. Paste the Qualcomm API key and endpoint there, then tell me when it says Key works." Wait for their reply, then re-run the check.
  - If you are running in the cloud (claude.ai/code) and cannot open a window, tell the human to add `QUALCOMM_API_KEY` and `QUALCOMM_ENDPOINT` as environment variables in the environment settings and restart the session.
- Confirm `git check-ignore backend/.env` prints `backend/.env`. If it doesn't, STOP and tell the human.

### Step 3: build B7
Do task **B7** in `docs/TASKS.md`, following the "Qualcomm Cloud AI 100" section of `docs/contracts/api.md` (v1.2).
- Load `backend/.env` with python-dotenv (add it to requirements.txt). Real env vars win.
- First verify the real API with the key: `GET {QUALCOMM_ENDPOINT}/models`, then a tiny `POST {QUALCOMM_ENDPOINT}/chat/completions` (OpenAI-compatible, `Authorization: Bearer`). Prefer a **Llama 3.3** model for the copilot (fast, short replies), not DeepSeek-R1. If the API is not OpenAI-style, use Qualcomm's `python-imagine-sdk`.
- Tests use a mocked HTTP transport and must pass with **no** keys.
- **Never print, log or commit the key.** Before committing, run `git status` and make sure `.env` is not staged.
- Branch `claude2/B7-qualcomm`, one PR to main, PR title `B7: Qualcomm Cloud AI 100 integration`. In the PR description, include the model id you chose and the output of one real copilot call (the reply text only).
- Print the PR URL for the human.

### Step 4: then B6
After the B7 PR is open, do **B6** (demo hardening) on `claude2/B6-hardening`, one PR, and print its URL.

- [ ] B7 PR opened
- [ ] B6 PR opened

---

## 2026-11-03 10:05: Review result
B1–B5 approved and merged into main. Great work.
