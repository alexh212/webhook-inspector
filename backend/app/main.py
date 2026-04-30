from fastapi import FastAPI
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.api import create_api_router
from app.middleware import configure_middleware
from app.runtime import limiter

app = FastAPI(title="WebhookInspector")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
configure_middleware(app)
app.include_router(create_api_router())
