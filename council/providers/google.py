from google import genai
from google.genai import types

from .base import Message, Provider


class GoogleProvider(Provider):
    def __init__(self, model_id: str, api_key: str):
        super().__init__(model_id, api_key)
        self.client = genai.Client(api_key=api_key)

    def send_message(self, messages: list[Message]) -> str:
        system_instruction = None
        contents = []

        for msg in messages:
            if msg.role == "system":
                system_instruction = msg.content
            elif msg.role == "user":
                contents.append(types.Content(role="user", parts=[types.Part(text=msg.content)]))
            elif msg.role == "assistant":
                contents.append(types.Content(role="model", parts=[types.Part(text=msg.content)]))

        config = types.GenerateContentConfig(
            max_output_tokens=2048,
            system_instruction=system_instruction,
        )

        response = self.client.models.generate_content(
            model=self.model_id,
            contents=contents,
            config=config,
        )
        return response.text
