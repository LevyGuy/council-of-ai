from collections.abc import Generator

from google import genai
from google.genai import types

from .base import Message, Provider


class GoogleProvider(Provider):
    def __init__(self, model_id: str, api_key: str):
        super().__init__(model_id, api_key)
        self.client = genai.Client(api_key=api_key)

    def _prepare(self, messages: list[Message]) -> tuple[str | None, list[types.Content]]:
        system_instruction = None
        contents = []
        for msg in messages:
            if msg.role == "system":
                system_instruction = msg.content
            elif msg.role == "user":
                contents.append(types.Content(role="user", parts=[types.Part(text=msg.content)]))
            elif msg.role == "assistant":
                contents.append(types.Content(role="model", parts=[types.Part(text=msg.content)]))
        return system_instruction, contents

    def send_message(self, messages: list[Message]) -> str:
        system_instruction, contents = self._prepare(messages)
        config = types.GenerateContentConfig(
            max_output_tokens=2048,
            system_instruction=system_instruction,
            thinking_config=types.ThinkingConfig(thinking_budget=1024),
        )
        response = self.client.models.generate_content(
            model=self.model_id,
            contents=contents,
            config=config,
        )
        return response.text

    def stream_message(self, messages: list[Message]) -> Generator[str, None, None]:
        system_instruction, contents = self._prepare(messages)
        config = types.GenerateContentConfig(
            max_output_tokens=2048,
            system_instruction=system_instruction,
            thinking_config=types.ThinkingConfig(thinking_budget=1024),
        )
        for chunk in self.client.models.generate_content_stream(
            model=self.model_id,
            contents=contents,
            config=config,
        ):
            if chunk.text:
                yield chunk.text
