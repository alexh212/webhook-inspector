import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import declarative_base

Base = declarative_base()


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Endpoint(Base):
    __tablename__ = "endpoints"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=True)
    session_id = Column(String(64), nullable=True, index=True)
    secret = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=_utcnow)


class CapturedRequest(Base):
    __tablename__ = "captured_requests"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    endpoint_id = Column(UUID(as_uuid=True), ForeignKey("endpoints.id", ondelete="CASCADE"))
    method = Column(String(10))
    headers = Column(JSONB)
    body = Column(Text)
    query_params = Column(JSONB)
    source_ip = Column(String(45))
    content_type = Column(String(255))
    received_at = Column(DateTime, default=_utcnow)


class DeliveryAttempt(Base):
    __tablename__ = "delivery_attempts"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id = Column(UUID(as_uuid=True), ForeignKey("captured_requests.id", ondelete="CASCADE"))
    destination_url = Column(Text, nullable=False)
    status_code = Column(String(10), nullable=True)
    response_headers = Column(JSONB, nullable=True)
    response_body = Column(Text, nullable=True)
    duration_ms = Column(String(20), nullable=True)
    error = Column(Text, nullable=True)
    attempted_at = Column(DateTime, default=_utcnow)
