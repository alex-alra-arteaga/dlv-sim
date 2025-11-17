import sys
import torch
import torch.nn as nn
import numpy as np
from torch.distributions import Categorical

class DummyReLUFeatureExtractor(nn.Module):
    def __init__(self, input_dim, features_dim0: int = 16, features_dim1: int = 64, features_dim2: int = 128, features_dim: int = 128):
        super().__init__()
        self.pre_layer = nn.Sequential(
            nn.Flatten(),                 
            nn.Linear(input_dim, features_dim0),
            #nn.LayerNorm(features_dim0),
            nn.GELU(),
            nn.Linear(features_dim0, features_dim1),
            #nn.LayerNorm(features_dim1),
            nn.GELU(),
            nn.Linear(features_dim1, features_dim2),
            #nn.LayerNorm(features_dim2),
            nn.GELU(),
            nn.Linear(features_dim2, features_dim),
            #nn.LayerNorm(features_dim),
            nn.GELU()
        )

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        if obs.ndim == 1:
            obs = obs.unsqueeze(0)
        obs = obs.to(dtype=torch.float32)
        return self.pre_layer(obs)

class actor(nn.Module):
    def __init__(self, 
            obs_dim: int = 4, 
            action_dim: int = 2
        ):
        super().__init__()

        self.obs_dim = obs_dim
        self.action_dim = action_dim

        self.features_extractor = DummyReLUFeatureExtractor(input_dim = obs_dim)

        self.policy_net = nn.Sequential(
            nn.Linear(128, 128),
            nn.GELU(),
            nn.Linear(128, 128),
            nn.GELU()
        )

        self.action_net = nn.Linear(128, action_dim)
    
    def forward(self, obs):
        if obs.ndim == 1:              
            obs = obs.unsqueeze(0)      
        elif obs.ndim == 2 and obs.shape[0] == 1:
            pass                        

        feats = self.features_extractor(obs)

        x = self.policy_net(feats)
        logits = self.action_net(x)

        return logits  


    def act(self, obs, device="cpu", deterministic=True):
        if isinstance(obs, np.ndarray):
            obs = torch.as_tensor(obs, dtype=torch.float32, device=device)
        elif not torch.is_tensor(obs):
            obs = torch.tensor(obs, dtype=torch.float32, device=device)

        with torch.no_grad():
            logits = self.forward(obs)
            dist = torch.distributions.Categorical(logits=logits)

            if deterministic:
                action = torch.argmax(dist.logits, dim=-1)
            else:
                action = dist.sample()

        return action.squeeze().cpu().numpy().item()
    
    def set_initial_state(self, file_path, device = "cpu"):
        state = torch.load(file_path, map_location = device, weights_only=True)
        missing = []
        unexpected = []

        res = self.features_extractor.load_state_dict(state["features_extractor"], strict=False)
        missing += res.missing_keys
        unexpected += res.unexpected_keys

        res = self.policy_net.load_state_dict(state["policy_net"], strict=False)
        missing += res.missing_keys
        unexpected += res.unexpected_keys

        res = self.action_net.load_state_dict(state["action_net"], strict=False)
        missing += res.missing_keys
        unexpected += res.unexpected_keys

        if missing or unexpected:
            print("Keys mismatch:", file=sys.stderr)
            if missing:
                print("Missing:", missing, file=sys.stderr)
            if unexpected:
                print("Unexpected:", unexpected, file=sys.stderr)
        else:
            print("All weights loaded successfully.", file=sys.stderr)

        self.to(device)

        self.eval()