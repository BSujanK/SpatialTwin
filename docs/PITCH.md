# SpatialTwin: pitch and demo script (Lead-owned)

## The problem (real, quantified)
- Unplanned downtime costs the world's 500 largest companies about **$1.4 trillion a year** (~11% of revenue), up from $864B in 2019–20. Source: Siemens, *The True Cost of Downtime 2024*.
- One hour of downtime at a large **automotive plant costs ~$2.3M** (more than $600 per second), roughly double the 2019 figure. Source: same report.
- Factories are becoming **autonomous and lights-out**: fewer people on the floor, and each technician covers more machines. Experienced technicians are retiring faster than knowledge can be handed down.
- So when something breaks, two questions decide the cost: **which machine first?** and **how fast can whoever's available fix it correctly?**

## The solution: one closed autonomous loop
**Detect → Diagnose → Prioritise → Dispatch → Guide → Resolve.** The agent runs the loop by itself, and the human only does the physical repair.
1. **Live digital twin.** Sensor telemetry is mapped onto a 3D model of every machine, with predicted time to failure.
2. **Quantum-inspired scheduler.** Repair ordering is formulated as a **QUBO** (the native problem format of quantum annealers) and solved by simulated annealing today. The objective is **USD of expected downtime loss**, not a severity guess. The same QUBO can run on quantum annealing hardware without being rewritten.
3. **Agentic AR copilot.** It walks the technician through the procedure step by step, highlights the exact part in AR, speaks the instructions, enforces safety (lockout/tagout) and answers questions using live sensor context.
4. **Impact HUD.** It shows dollars at risk per hour, downtime cost avoided and mean time to repair (MTTR), all live.

5. **Powered by Qualcomm Cloud AI 100.** Copilot dialogue and the agent's root-cause analysis run on Qualcomm Cloud AI 100 inference (Qualcomm AI Inference Suite). It's built for fast, power-efficient inference at scale, which suits an always-on agent watching every machine in a plant. **Roadmap:** the same loop runs at the edge on a Qualcomm Dragonwing board (Arduino UNO Q) wired to real machine sensors, so diagnosis keeps working when the factory network is down.

## Business impact model (illustrative plant, numbers on screen)
- 5 machines on one line, downtime cost of $3k–15k/hour each.
- Optimised order vs a naive "worst health first" order: the screen shows `savings_usd` for each re-plan.
- AR-guided work instructions: vendor case studies report **~25–40% lower repair time** (unverified marketing figures; quote the range, attributed, as "reported").
- Pitch line: *"Each re-plan we just watched saved $5.5k of expected downtime on a single line. A plant has dozens of lines."*

## Honesty guardrails (judges ask)
- Sensors are **simulated** for the demo. In production they'd come from OPC UA / MQTT.
- "Quantum-inspired" means classical simulated annealing on a QUBO. We don't claim to run on a quantum computer.
- Dollar figures are illustrative per-machine rates. The method, not the numbers, is the product.

## 3-minute demo script
1. **(0:00) Hook.** "$2.3M an hour. That's what a stopped automotive line costs." Show the HUD: $ at risk ticking.
2. **(0:20) Twin.** Orbit the 3D factory: green/amber/red machines, live sensors, "fails in 18 min".
3. **(0:45) The agent acts on its own.** Point at the HUD chip "AI: Qualcomm Cloud AI 100". Click **Reset demo**, then inject `SPINDLE-VIB` on the healthy CNC-01. The feed shows detect → diagnose → **Qualcomm Cloud AI 100 root cause** → ⚛️ re-optimised (saves $X vs greedy) → technicians dispatched. The rank badges reorder in the scene and "$ at risk/hour" jumps.
4. **(1:20) AR repair.** Open the **rank-1 machine** (the one a technician was just dispatched to, normally CONV-02). On the phone, tap **Enter AR**: the twin appears on the table. Start the guided repair. The copilot speaks, the lockout warning appears, the part glows. Ask "what's the vibration?" to get a live-sensor answer. Say done through the steps.
4b. **(new) Autonomous control: insights act on the machine.** Open the **Autonomous control** tab and set **Auto**. Inject `BRG-OVERHEAT` on PUMP-03. The agent derates the pump to 70% with coolant at 100%. The pump gets a **⚙ 70%** chip and goes from "fails in 18" to "fails in 60 min". The card shows **−$900/h throughput, avoids ~$9.8k expected loss**, plus the Qualcomm Cloud AI 100 rationale, and the "Failures prevented / +N min" tile updates. Say: *"The AI explains, but never sets a number: a deterministic policy inside a safety envelope does, and every action is reversible."* Then switch to **Approve** and show the one-click human-in-the-loop path (Approve / Reject / Revert).
5. **(2:20) Resolve.** The machine turns green, MTTR is recorded, the downtime-avoided counter rises, and the agent dispatches the next job automatically.
6. **(2:40) Close.** "Detect, decide, dispatch, guide, resolve: one autonomous loop with the human in the right place. SpatialTwin."

## Sources
- Siemens, The True Cost of Downtime 2024: https://assets.new.siemens.com/siemens/assets/api/uuid:1b43afb5-2d07-47f7-9eb7-893fe7d0bc59/TCOD-2024_original.pdf
- AR repair-time claims (vendor, unverified): https://www.zoho.com/lens/how-to-measure-ar-remote-assistance-roi.html
