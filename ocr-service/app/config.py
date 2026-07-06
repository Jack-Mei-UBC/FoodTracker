from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    openrouter_api_key: str
    ocr_model: str = "nvidia/nemotron-nano-12b-v2-vl:free"
    max_upload_bytes: int = 10_000_000
    max_image_dimension: int = 1792
    request_timeout_seconds: int = 60
    openrouter_base_url: str = "https://openrouter.ai/api/v1"


settings = Settings()
