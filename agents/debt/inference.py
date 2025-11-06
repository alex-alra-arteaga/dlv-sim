#!/usr/bin/env python3
import json
import math
import sys
from typing import Dict, List, Tuple

OBS_DIM = 10
LEVERAGE_BOTTOM = 1.8
LEVERAGE_TOP = 2.2
LEVERAGE_RANGE = LEVERAGE_TOP - LEVERAGE_BOTTOM


def _zero_center(value: float) -> float:
    """Map normalised 0..1 slope values back to approximately [-1, 1]."""
    if not math.isfinite(value):
        return 0.0
    return max(-1.0, min(1.0, (value - 0.5) * 2.0))


def _clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return max(0.0, min(1.0, value))


def _decide_action(obs: List[float], state: Dict[str, float]) -> int:
    (
        leverage_norm,
        cr_norm,
        leverage_mean_norm,
        leverage_slope_norm,
        vol_ratio,
        vol_mean,
        vol_slope_norm,
        calm_part,
        calm_mean,
        calm_slope_norm,
    ) = obs

    leverage_norm = _clamp01(leverage_norm)
    cr_norm = _clamp01(cr_norm)
    leverage_mean_norm = _clamp01(leverage_mean_norm)
    vol_ratio = _clamp01(vol_ratio)
    vol_mean = _clamp01(vol_mean)
    calm_part = _clamp01(calm_part)
    calm_mean = _clamp01(calm_mean)

    leverage_slope = _zero_center(leverage_slope_norm)
    vol_slope = _zero_center(vol_slope_norm)
    calm_slope = _zero_center(calm_slope_norm)

    last_action = state.get("last_action", 1)

    increase_pressure = (
        (0.35 - leverage_norm) * 2.0
        + (cr_norm - 0.55) * 1.5
        + (calm_part - calm_mean) * 0.8
        - abs(vol_slope) * 0.6
        - abs(calm_slope) * 0.4
    )
    decrease_pressure = (
        (leverage_norm - 0.65) * 2.0
        + (0.45 - cr_norm) * 1.7
        + (vol_ratio - vol_mean) * 0.9
        + max(0.0, leverage_slope) * 0.8
        + max(0.0, vol_slope) * 0.6
    )

    leverage_gap = leverage_mean_norm - leverage_norm

    gap_abs = abs(leverage_gap)
    calm_delta = abs(calm_part - calm_mean)

    leverage_actual = LEVERAGE_BOTTOM + leverage_norm * LEVERAGE_RANGE
    leverage_mean_actual = LEVERAGE_BOTTOM + leverage_mean_norm * LEVERAGE_RANGE

    if cr_norm > 0.65 and vol_ratio < 0.9:
        target_action = 2
    elif cr_norm < 0.48 or vol_ratio > 0.95:
        target_action = 3
    elif leverage_slope > 0.12 or vol_slope > 0.12:
        target_action = 3
    elif leverage_slope < -0.12 or vol_slope < -0.12:
        target_action = 2
    elif gap_abs < 0.02 and calm_delta < 0.03 and abs(vol_ratio - vol_mean) < 0.03:
        target_action = 1
    elif leverage_actual < (LEVERAGE_BOTTOM + 0.1) and cr_norm >= 0.52:
        target_action = 2
    elif leverage_actual > (LEVERAGE_TOP - 0.1) or cr_norm <= 0.42:
        target_action = 3
    elif increase_pressure > 0.4 and decrease_pressure < 0.2:
        target_action = 2
    elif decrease_pressure > 0.3 and increase_pressure < 0.25:
        target_action = 3
    else:
        if abs(leverage_slope) < 0.05 and abs(vol_slope) < 0.05:
            target_action = last_action
        elif last_action in (2, 3):
            target_action = 1
        else:
            target_action = 1

    state["last_action"] = target_action
    return int(target_action)


def _handle_command(payload: Dict[str, object], state: Dict[str, float]) -> Tuple[bool, Dict[str, object]]:
    cmd = payload.get("type")
    if cmd == "reset":
        state.clear()
        return True, {"status": "reset"}

    if cmd != "infer":
        return False, {"error": "unknown_command"}

    obs = payload.get("obs")
    if not isinstance(obs, list) or len(obs) != OBS_DIM:
        return False, {"error": "invalid_observation"}

    obs_numbers: List[float] = []
    for value in obs:
        try:
            obs_numbers.append(float(value))
        except (TypeError, ValueError):
            return False, {"error": "invalid_observation"}

    action = _decide_action(obs_numbers, state)
    return True, {"action": action}


def main() -> None:
    state: Dict[str, float] = {}
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps({"error": "invalid_json"}), flush=True)
            continue

        success, response = _handle_command(payload, state)
        print(json.dumps(response), flush=True)

        if not success:
            # If something went wrong, keep the state consistent but do not exit.
            continue


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
