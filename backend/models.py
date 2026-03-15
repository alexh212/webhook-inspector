import uuid
from sqlalchemy import Column, String, Text, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import declarative_base
from datetime import datetime

Base = declarative_base()

class Endpoint(Base):
    __tablename__ = "endpoints"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

class CapturedRequest(Base):
    __tablename__ = "captured_requests"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    endpoint_id = Column(UUID(as_uuid=True), ForeignKey("endpoints.id"))
    method = Column(String(10))
    headers = Column(JSONB)
    body = Column(Text)
    query_params = Column(JSONB)
    source_ip = Column(String(45))
    content_type = Column(String(255))
    received_at = Column(DateTime, default=datetime.utcnow)
