from collections.abc import Generator

from openai import OpenAI

from .base import Message, Provider


class OpenAIProvider(Provider):
    def __init__(self, model_id: str, api_key: str, base_url: str | None = None):
        super().__init__(model_id, api_key)
        kwargs = {"api_key": api_key}
        if base_url:
            kwargs["base_url"] = base_url
        self.client = OpenAI(**kwargs)

    def _prepare(self, messages: list[Message]) -> list[dict]:
        return [{"role": msg.role, "content": msg.content} for msg in messages]

    def send_message(self, messages: list[Message]) -> str:
        api_messages = self._prepare(messages)
        response = self.client.chat.completions.create(
            model=self.model_id,
            messages=api_messages,
            max_tokens=2048,
        )
        return response.choices[0].message.content

    def stream_message(self, messages: list[Message]) -> Generator[str, None, None]:
        api_messages = self._prepare(messages)
        stream = self.client.chat.completions.create(
            model=self.model_id,
            messages=api_messages,
            max_tokens=2048,
            stream=True,
        )
        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content
