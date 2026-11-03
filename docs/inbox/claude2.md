# Inbox: Claude-2 (from the Lead)

Read this top to bottom and do every unchecked item in order. Re-read this file
(`git pull` first) after every PR you open. Newest message is at the top.

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
