# AGENTS.md — rules for every agent on SpatialTwin

Read this file, `docs/contracts/api.md`, `docs/TASKS.md` and `docs/STATUS.md` before writing any code.

**Your inbox:** the Lead sends instructions through `docs/inbox/<you>.md` (`claude2.md`, `astra.md`). When the human says "check your inbox", and after every PR you open, run `git pull` on main and do any new items there. Inbox instructions override TASKS.md ordering.

## Team

| Agent | Role | Owns (may edit) |
|---|---|---|
| **Lead** (Claude, Opus) | Plans, writes contracts, reviews and merges every PR, keeps `docs/STATUS.md` current | `docs/`, `shared/`, root files, final integration |
| **Claude-2** (builder) | Backend: telemetry simulator, quantum-inspired scheduler, copilot API | `backend/` |
| **Astra** (GPT builder) | Frontend: 3D digital twin, WebXR AR mode, copilot + schedule UI | `frontend/` |

**Do not edit files outside the folder you own.** If you need a change in `docs/contracts/` or `shared/`, say so in your PR description and the Lead will make it.

## Deadline

Hackathon demo at **13:00 IST, 2026-11-03**. Code freeze at **12:40**. Working beats perfect. Do not gold-plate.

## Workflow

1. Take the next task with your name in `docs/TASKS.md`.
2. Branch from latest `main`: `claude2/<task-id>-<slug>` or `astra/<task-id>-<slug>` (e.g. `astra/F1-scene`).
3. Commit small and often. Message format: `<task-id>: <what changed>` (e.g. `B2: add QUBO annealer`).
4. Push your branch and open a PR to `main` titled `<task-id>: <summary>`. In the description, give: what you did, how to run it, and how you tested it.
5. **Never push to `main`. Never force-push. Only the Lead merges.**
6. After the Lead merges, pull `main` and start the next task. If the Lead asks for changes on the PR, fix them on the same branch.
7. If you are blocked for more than 10 minutes, write it in your PR or ask the human operator to tell the Lead. Do not invent your own contract.

## The contract is law

`docs/contracts/api.md` defines every endpoint and JSON shape between the backend and frontend. `shared/mock/*.json` contains example payloads that match it exactly.
- The backend must return these shapes exactly.
- The frontend must work in mock mode (reading `shared/mock/`) before the backend exists, then switch to the live API by setting one env var.

## Engineering rules

- Keep it simple and runnable with one command per side (see README).
- No secrets in the repo. Read the API key from env (`ANTHROPIC_API_KEY`). `.env` files are gitignored.
- The repo is **public**. Don't commit personal data or absolute local paths.
- Everything must still work for the demo **without** an API key or an AR device (scripted copilot fallback, desktop 3D fallback).
- Add a few fast tests for logic (scheduler, endpoints). No UI tests needed.
