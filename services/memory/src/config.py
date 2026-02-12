from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql://coda:coda@postgres:5432/coda"
    memory_api_key: str = ""
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    log_level: str = "info"
    max_content_length: int = 5000
    pool_min_size: int = 2
    pool_max_size: int = 10

    model_config = {"env_prefix": "", "case_sensitive": False}


settings = Settings()
