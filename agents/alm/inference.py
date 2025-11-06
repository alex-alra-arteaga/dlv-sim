#!/usr/bin/env python3
import json
import os
import sys
import torch

from model import actor as AlmActor


def _load_agent(device: torch.device) -> AlmActor:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    weights_path = os.path.join(base_dir, "actor_weights.pth")

    agent = AlmActor(obs_dim=4, action_dim=2)
    agent.set_initial_state(weights_path, device=device)
    agent.eval()
    return agent


def main() -> None:
    device = torch.device("cpu")
    torch.set_grad_enabled(False)
    torch.manual_seed(0)

    agent = _load_agent(device)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps({"error": "invalid_json"}), flush=True)
            continue

        cmd = payload.get("type")
        if cmd == "reset":
            print(json.dumps({"status": "reset"}), flush=True)
            continue

        if cmd != "infer":
            print(json.dumps({"error": "unknown_command"}), flush=True)
            continue

        obs = payload.get("obs")
        if not isinstance(obs, list) or len(obs) != agent.obs_dim:
            print(json.dumps({"error": "invalid_observation"}), flush=True)
            continue

        try:
            action = agent.act(obs, device=device, deterministic=True)
        except Exception as exc:  # pylint: disable=broad-except
            print(json.dumps({"error": str(exc)}), flush=True)
            continue

        print(json.dumps({"action": int(action)}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
