"""Repair procedures per fault code. BRG-OVERHEAT is copied from shared/mock/procedure_BRG-OVERHEAT.json."""
from __future__ import annotations

from typing import Optional


def _s(index, title, instruction, part, warning=None):
    return {"index": index, "title": title, "instruction": instruction, "part": part, "safety_warning": warning}


PROCEDURES: dict[str, dict] = {
    "BRG-OVERHEAT": {
        "fault_code": "BRG-OVERHEAT",
        "title": "Replace drive-end bearing, Coolant Pump",
        "steps": [
            _s(0, "Lock out the pump", "Switch the isolator on the control panel to OFF and apply your lockout tag.", "panel",
               "Verify zero energy: press START and confirm the pump does not move."),
            _s(1, "Let it cool", "Wait until the bearing housing reads below 50 °C on the overlay.", "bearing",
               "The housing can exceed 90 °C. Wear heat-resistant gloves."),
            _s(2, "Remove the coupling guard", "Undo the four M8 bolts and lift the guard off the motor shaft.", "motor"),
            _s(3, "Pull the old bearing", "Fit the puller to the highlighted bearing and extract it evenly.", "bearing"),
            _s(4, "Fit the new bearing and restart",
               "Heat-mount the new 6308-2RS bearing, refit the guard to 25 Nm, remove the lockout and run for 2 minutes.",
               "bearing", "Keep hands clear of the coupling during the test run."),
        ],
    },
    "BELT-SLIP": {
        "fault_code": "BELT-SLIP",
        "title": "Re-tension and align drive belt, Main Conveyor",
        "steps": [
            _s(0, "Lock out the conveyor", "Isolate the drive at the control panel, apply your lockout tag and try to start to confirm it is dead.",
               "panel", "Verify zero energy before touching the belt: pinch points and stored tension."),
            _s(1, "Inspect the belt", "Check the belt for glazing, fraying and contamination along the highlighted run.", "belt",
               "Keep fingers out of the belt-to-roller nip points."),
            _s(2, "Loosen the motor mount", "Slacken the four motor mount bolts so the drive can slide.", "motor"),
            _s(3, "Re-tension the belt", "Adjust the take-up until deflection is about 10 mm at mid-span, then check pulley alignment.", "belt"),
            _s(4, "Tighten and test run", "Torque the motor mount bolts, remove the lockout and run unloaded for 2 minutes. Speed should match the setpoint.",
               "belt", "Stand clear of the belt line during the test run."),
        ],
    },
    "HYD-LEAK": {
        "fault_code": "HYD-LEAK",
        "title": "Fix hydraulic line leak, Hydraulic Press",
        "steps": [
            _s(0, "Lock out and depressurise", "Isolate the press at the control panel, apply your lockout tag and open the accumulator bleed valve.", "panel",
               "Stored hydraulic pressure can inject oil through skin. Confirm the gauge reads 0 bar before going further."),
            _s(1, "Locate the leak", "Wipe the highlighted line and fittings dry, then look for fresh oil at the joints.", "hydraulic_line",
               "Never check for leaks with your hand. Use cardboard and eye protection."),
            _s(2, "Replace the hose or fitting", "Remove the damaged section, fit a new hose or O-ring, and tighten the fittings to the marked torque.", "hydraulic_line"),
            _s(3, "Refill and bleed", "Top up the reservoir to the mark and bleed air from the line at the highlighted valve.", "valve",
               "Wear gloves: hydraulic oil is hot and slippery."),
            _s(4, "Pressure test", "Remove the lockout, bring the press to working pressure and watch the joint for 2 minutes. Pressure must hold steady.", "hydraulic_line",
               "Stay clear of the press and the line during the pressure test."),
        ],
    },
    "SPINDLE-VIB": {
        "fault_code": "SPINDLE-VIB",
        "title": "Inspect and rebalance spindle, CNC Mill",
        "steps": [
            _s(0, "Stop and lock out the mill", "Stop the spindle, switch the isolator to OFF at the panel and apply your lockout tag.", "panel",
               "Wait for the spindle to stop fully and verify zero energy."),
            _s(1, "Remove the tool and holder", "Take out the cutter and tool holder and check the taper for damage or debris.", "spindle",
               "Cutting tools are sharp. Wear cut-resistant gloves."),
            _s(2, "Inspect the spindle bearings", "Turn the spindle by hand and feel for roughness or play at the highlighted bearing.", "spindle"),
            _s(3, "Clean and refit", "Clean the taper, refit a balanced tool holder and check the drawbar tension.", "spindle"),
            _s(4, "Run-up test", "Remove the lockout and run the spindle up in steps to 8000 rpm. Vibration should stay below 4 mm/s.", "spindle",
               "Close the door and keep clear during run-up."),
        ],
    },
    "JOINT-STALL": {
        "fault_code": "JOINT-STALL",
        "title": "Free and recalibrate stalled joint, Welding Robot",
        "steps": [
            _s(0, "Lock out the robot", "Press the emergency stop, switch the controller isolator to OFF and apply your lockout tag.", "panel",
               "The arm can drop when brakes release. Support it or lower it to its rest position first."),
            _s(1, "Inspect the joint", "Check the highlighted joint for cable pinch, debris or a damaged cover.", "arm_joint",
               "Keep your hands out of the arm's swing range."),
            _s(2, "Check the motor and cabling", "Inspect the joint motor connector and cable for wear and tighten any loose terminals.", "motor"),
            _s(3, "Lubricate the joint", "Apply the specified grease to the joint reducer and move it by hand through its full range.", "arm_joint"),
            _s(4, "Recalibrate and test", "Remove the lockout, run the home routine and a slow test path. Motor current should stay normal.", "arm_joint",
               "Keep everyone outside the work cell during the test."),
        ],
    },
}


def get_procedure(code: str) -> Optional[dict]:
    return PROCEDURES.get(code)
