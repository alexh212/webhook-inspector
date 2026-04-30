import uuid
from typing import Optional

from fastapi import Header, HTTPException

from app.db.session import get_db, get_session_factory


def parse_uuid(value: str, label: str = "ID") -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail=f"Invalid {label}: {value}")


def get_session_id(x_session_id: Optional[str] = Header(None)) -> str:
    if not x_session_id or len(x_session_id) < 16:
        raise HTTPException(status_code=401, detail="Missing or invalid session ID")
    return x_session_id


__all__ = ["get_db", "get_session_factory", "get_session_id", "parse_uuid"]
