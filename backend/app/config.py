import os

from dotenv import load_dotenv

load_dotenv()

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:5174").split(",")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
MAX_BODY_SIZE = 1 * 1024 * 1024
