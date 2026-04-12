import argparse
import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class ModelConfig:
    name: str
    provider: str
    model_id: str
    api_key: str | None = None
    api_key_env: str | None = None

    def get_api_key(self) -> str | None:
        # Direct key takes priority, then fall back to env var lookup
        if self.api_key:
            return self.api_key
        if self.api_key_env:
            return os.environ.get(self.api_key_env)
        return None


@dataclass
class SessionConfig:
    max_iterations: int = 4
    transcript_dir: str = "./transcripts"
    shuffle: bool = True


@dataclass
class AppConfig:
    models: list[ModelConfig] = field(default_factory=list)
    session: SessionConfig = field(default_factory=SessionConfig)


def load_config(config_path: str) -> AppConfig:
    path = Path(config_path)
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(path) as f:
        raw = yaml.safe_load(f)

    models = [
        ModelConfig(
            name=m["name"],
            provider=m["provider"],
            model_id=m["model_id"],
            api_key=m.get("api_key"),
            api_key_env=m.get("api_key_env"),
        )
        for m in raw.get("models", [])
    ]

    session_raw = raw.get("session", {})
    session = SessionConfig(
        max_iterations=session_raw.get("max_iterations", 4),
        transcript_dir=session_raw.get("transcript_dir", "./transcripts"),
        shuffle=session_raw.get("shuffle", True),
    )

    return AppConfig(models=models, session=session)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="council",
        description="Council of AI — Multi-LLM deliberation CLI",
    )
    parser.add_argument("--config", default="./config.yaml", help="Path to config file")
    parser.add_argument("--max-iterations", type=int, default=None, help="Override max iterations")
    parser.add_argument("--no-shuffle", action="store_true", help="Disable random model shuffling")
    parser.add_argument("--models", type=str, default=None, help="Comma-separated model names to include")
    return parser.parse_args()


def build_config() -> AppConfig:
    args = parse_args()
    config = load_config(args.config)

    if args.max_iterations is not None:
        config.session.max_iterations = args.max_iterations
    if args.no_shuffle:
        config.session.shuffle = False
    if args.models:
        selected = {name.strip() for name in args.models.split(",")}
        config.models = [m for m in config.models if m.name in selected]

    # Filter out models without API keys
    available = []
    missing = []
    for m in config.models:
        if m.get_api_key():
            available.append(m)
        else:
            missing.append(m.name)

    if missing:
        from rich.console import Console
        Console(stderr=True).print(
            f"[yellow]Warning: Skipping models with missing API keys: {', '.join(missing)}[/yellow]"
        )

    if len(available) < 2:
        raise RuntimeError(
            f"At least 2 models with valid API keys are required. Only {len(available)} available."
        )

    config.models = available
    return config
