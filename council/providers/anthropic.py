import anthropic

from .base import Message, Provider


class AnthropicProvider(Provider):
    def __init__(self, model_id: str, api_key: str):
        super().__init__(model_id, api_key)
        self.client = anthropic.Anthropic(api_key=api_key)

    def send_message(self, messages: list[Message]) -> str:
        system_parts = []
        api_messages = []

        for msg in messages:
            if msg.role == "system":
                system_parts.append(msg.content)
            else:
                api_messages.append({"role": msg.role, "content": msg.content})

        response = self.client.messages.create(
            model=self.model_id,
            max_tokens=2048,
            system="\n\n".join(system_parts) if system_parts else anthropic.NOT_GIVEN,
            messages=api_messages,
        )
        return response.content[0].text
