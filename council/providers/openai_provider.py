from openai import OpenAI

from .base import Message, Provider


class OpenAIProvider(Provider):
    def __init__(self, model_id: str, api_key: str, base_url: str | None = None):
        super().__init__(model_id, api_key)
        kwargs = {"api_key": api_key}
        if base_url:
            kwargs["base_url"] = base_url
        self.client = OpenAI(**kwargs)

    def send_message(self, messages: list[Message]) -> str:
        api_messages = [{"role": msg.role, "content": msg.content} for msg in messages]

        response = self.client.chat.completions.create(
            model=self.model_id,
            messages=api_messages,
            max_tokens=2048,
        )
        return response.choices[0].message.content
