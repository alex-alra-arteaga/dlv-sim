import torch
import torch.nn as nn
import numpy as np
from torch.distributions import Categorical

class DummyReLUFeatureExtractor(nn.Module):
    def __init__(self, input_dim, features_dim=64):
        super().__init__()
        self.pre_layer = nn.Sequential(
            nn.Flatten(),
            nn.Linear(input_dim, features_dim),
            nn.ReLU()
        )

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        if obs.ndim == 1:
            obs = obs.unsqueeze(0)
        obs = obs.to(dtype=torch.float32)
        return self.pre_layer(obs)

class reccurentActor(nn.Module):
    def __init__(self, 
            obs_dim: int = 10, 
            action_dim: int = 4
        ):
        super().__init__()

        self.obs_dim = obs_dim
        self.action_dim = action_dim

        self.features_extractor = DummyReLUFeatureExtractor(obs_dim, 128)

        self.lstm_actor = nn.LSTM(
            input_size=128,
            hidden_size=256,
            num_layers=1,
            batch_first=True
        )

        self.policy_net = nn.Sequential(
            nn.Linear(256, 256),
            nn.ReLU(),
            nn.Linear(256, 128),
            nn.ReLU()
        )

        self.action_net = nn.Linear(128, action_dim)

    def init_hidden(self, batch_size=1, device="cpu"):
        h = torch.zeros(1, batch_size, 256).to(device)
        c = torch.zeros(1, batch_size, 256).to(device)

        self.to(device)
        
        return (h, c)
    
    def forward(self, obs, hidden):
        if obs.ndim == 2:   
            obs = obs.unsqueeze(1)  
        elif obs.ndim == 1: 
            obs = obs.unsqueeze(0).unsqueeze(1) 

        batch, seq_len, _ = obs.shape
        feats = self.features_extractor(obs.view(-1, self.obs_dim))
        feats = feats.view(batch, seq_len, -1)

        lstm_out, new_hidden = self.lstm_actor(feats, hidden)

        x = self.policy_net(lstm_out)
        logits = self.action_net(x)  
        return logits, new_hidden
    
    def act(self, obs, hidden, device = "cpu"):
        if isinstance(obs, np.ndarray):
            obs = torch.as_tensor(obs, dtype=torch.float32, device=device)

        logits, new_hidden = self.forward(obs, hidden)
        logits = logits[:, -1, :]
        dist = Categorical(logits=logits)
        action = dist.sample()
        log_prob = dist.log_prob(action)
        return action, log_prob, new_hidden
    
    def set_initial_state(self, file_path, device = "cpu"):
        state = torch.load(file_path, map_location = device)

        self.features_extractor.load_state_dict(state["features_extractor"])
        self.lstm_actor.load_state_dict(state["lstm_actor"])
        self.policy_net.load_state_dict(state["policy_net"])
        self.action_net.load_state_dict(state["action_net"])

        self.to(device)

        self.eval()