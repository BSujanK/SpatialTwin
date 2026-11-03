# STATUS (maintained by the Lead)

_Last update: 10:05 IST_

## Timeline (IST, 2026-11-03)
| Time | Milestone |
|---|---|
| 09:35 | Scaffold on `main`, builders start |
| 10:45 | **M1**: B1+B2 merged; F1+F2 merged (frontend runs in mock mode) |
| 11:45 | **M2**: B5+B3 merged; F6+F3+F4 merged; **live integration test** |
| 12:20 | **M3**: F5 (AR) + B4 merged, bug fixes only after this |
| 12:40 | **Code freeze**, demo rehearsal |
| 13:00 | Demo |

## Board
| Task | Owner | State | PR |
|---|---|---|---|
| B1 | Claude-2 | ✅ merged | #1 |
| B2 | Claude-2 | ✅ merged | #2 |
| B5 | Claude-2 | ✅ merged | #3 |
| B3 | Claude-2 | ✅ merged | #4 |
| B4 | Claude-2 | ✅ merged | #5 |
| B7 | Claude-2 | todo, TOP PRIORITY (Qualcomm Cloud AI 100) | |
| B6 | Claude-2 | todo (after B7) | |
| F1 | Astra | todo | |
| F2 | Astra | todo | |
| F6 | Astra | todo (after F2) | |
| F3 | Astra | todo | |
| F4 | Astra | todo | |
| F5 | Astra | todo | |

## Blockers / decisions
- 10:15 **Hackathon rule: must use a Qualcomm kit.** We have the Cloud AI Playground key, so the AI brain (copilot + root-cause analysis) runs on Qualcomm Cloud AI 100. Contract v1.2 (additive). UNO Q edge node is roadmap only (no board).
- 10:05 Backend B1–B5 all merged (26 tests pass; Lead live smoke test OK: inject → detect/diagnose/schedule/dispatch, copilot walk, websocket). Added `/api/demo/reset` to the contract. Astra restarting from a local clone and owns F1–F6. Frontend is now the critical path. The frontend must proxy /api and /ws through Vite, so the phone in AR gets one HTTPS origin.
- 09:50 Contract v1.1 (additive only): business-impact fields, agent event loop and KPIs. New tasks B5 and F6. Pitch in docs/PITCH.md.
