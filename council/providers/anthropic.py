from collections.abc import Generator

import anthropic

from .base import Message, Provider


class AnthropicProvider(Provider):
    def __init__(self, model_id: str, api_key: str):
        super().__init__(model_id, api_key)
        self.client = anthropic.Anthropic(api_key=api_key)

    def _prepare(self, messages: list[Message]) -> tuple[str | anthropic.NotGiven, list[dict]]:
        system_parts = []
        api_messages = []
        for msg in messages:
            if msg.role == "system":
                system_parts.append(msg.content)
            else:
                api_messages.append({"role": msg.role, "content": msg.content})
        system = "\n\n".join(system_parts) if system_parts else anthropic.NOT_GIVEN
        return system, api_messages

    def send_message(self, messages: list[Message]) -> str:
        system, api_messages = self._prepare(messages)
        response = self.client.messages.create(
            model=self.model_id,
            max_tokens=2048,
            system=system,
            messages=api_messages,
        )
        return response.content[0].text

    def stream_message(self, messages: list[Message]) -> Generator[str, None, None]:
        system, api_messages = self._prepare(messages)
        with self.client.messages.stream(
            model=self.model_id,
            max_tokens=2048,
            system=system,
            messages=api_messages,
        ) as stream:
            for text in stream.text_stream:
                yield text
