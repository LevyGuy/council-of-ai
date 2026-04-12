import random
import time
from collections.abc import Generator

from .config import ModelConfig
from .providers.base import Message, Provider
from .providers.anthropic import AnthropicProvider
from .providers.openai_provider import OpenAIProvider
from .providers.google import GoogleProvider
from .providers.xai import XAIProvider

PROVIDER_MAP = {
    "anthropic": AnthropicProvider,
    "openai": OpenAIProvider,
    "google": GoogleProvider,
    "xai": XAIProvider,
}

MAX_RETRIES = 2
RETRY_BASE_DELAY = 1.0


class Model:
    def __init__(self, name: str, provider: Provider):
        self.name = name
        self.provider = provider

    def send(self, messages: list[Message]) -> str:
        last_error = None
        for attempt in range(MAX_RETRIES + 1):
            try:
                return self.provider.send_message(messages)
            except Exception as e:
                last_error = e
                if attempt < MAX_RETRIES:
                    time.sleep(RETRY_BASE_DELAY * (2 ** attempt))
        raise last_error

    def send_stream(self, messages: list[Message]) -> Generator[str, None, None]:
        last_error = None
        for attempt in range(MAX_RETRIES + 1):
            try:
                yield from self.provider.stream_message(messages)
                return
            except Exception as e:
                last_error = e
                if attempt < MAX_RETRIES:
                    time.sleep(RETRY_BASE_DELAY * (2 ** attempt))
        raise last_error


def create_model(config: ModelConfig) -> Model:
    provider_cls = PROVIDER_MAP.get(config.provider)
    if provider_cls is None:
        raise ValueError(f"Unknown provider: {config.provider}")
    provider = provider_cls(model_id=config.model_id, api_key=config.get_api_key())
    return Model(name=config.name, provider=provider)


class ModelQueue:
    def __init__(self, model_configs: list[ModelConfig], shuffle: bool = True):
        self.models = [create_model(cfg) for cfg in model_configs]
        if shuffle:
            random.shuffle(self.models)

    @property
    def first(self) -> Model:
        return self.models[0]

    @property
    def reviewers(self) -> list[Model]:
        return self.models[1:]

    @property
    def order_names(self) -> list[str]:
        return [m.name for m in self.models]
