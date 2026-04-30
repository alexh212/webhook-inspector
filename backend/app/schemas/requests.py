from typing import Optional

from pydantic import BaseModel, Field

from app.config import MAX_BODY_SIZE


class ReplayRequest(BaseModel):
    destination_url: str = Field(..., max_length=2048)
    body_override: Optional[str] = Field(None, max_length=MAX_BODY_SIZE)
