from .openai_provider import OpenAIProvider

XAI_BASE_URL = "https://api.x.ai/v1"


class XAIProvider(OpenAIProvider):
    def __init__(self, model_id: str, api_key: str):
        super().__init__(model_id, api_key, base_url=XAI_BASE_URL)
