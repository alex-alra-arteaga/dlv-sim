#!/usr/bin/env python3
import json
import os
import sys
import torch

from model import reccurentActor


def _load_agent(device: torch.device) -> reccurentActor:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    weights_path = os.path.join(base_dir, "actor_weights.pth")

    agent = reccurentActor(obs_dim=10, action_dim=4)
    agent.set_initial_state(weights_path, device=device)
    agent.eval()
    return agent


def main() -> None:
    device = torch.device("cpu")
    torch.set_grad_enabled(False)
    torch.manual_seed(0)

    agent = _load_agent(device)
    hidden = agent.init_hidden(batch_size=1, device=device)

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
            hidden = agent.init_hidden(batch_size=1, device=device)
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
            obs_tensor = torch.tensor(obs, dtype=torch.float32, device=device)
            logits, hidden = agent.forward(obs_tensor, hidden)
            logits_last = logits[:, -1, :]
            action = torch.argmax(logits_last, dim=-1).item()
        except Exception as exc:  # pylint: disable=broad-except
            print(json.dumps({"error": str(exc)}), flush=True)
            hidden = agent.init_hidden(batch_size=1, device=device)
            continue

        print(json.dumps({"action": int(action)}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
