from typing import Optional

from pydantic import BaseModel, Field


class EndpointCreate(BaseModel):
    name: Optional[str] = Field(None, max_length=255)
