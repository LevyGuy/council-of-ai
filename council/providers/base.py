from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class Message:
    role: str  # "system", "user", "assistant"
    content: str
    name: str | None = None  # display name of the model


class Provider(ABC):
    def __init__(self, model_id: str, api_key: str):
        self.model_id = model_id
        self.api_key = api_key

    @abstractmethod
    def send_message(self, messages: list[Message]) -> str:
        """Send messages and return the response text."""
        ...
