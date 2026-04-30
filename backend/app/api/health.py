from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app import runtime

router = APIRouter()


@router.get("/health")
async def health(db: AsyncSession = Depends(get_db)):
    checks = {"db": "ok", "redis": "ok"}
    try:
        await db.execute(text("SELECT 1"))
    except Exception as exc:
        runtime.logger.warning("Database health check failed: %s", exc)
        checks["db"] = "error"
    try:
        await runtime.redis_client.ping()
    except Exception as exc:
        runtime.logger.warning("Redis health check failed: %s", exc)
        checks["redis"] = "error"
    if not all(value == "ok" for value in checks.values()):
        raise HTTPException(status_code=503, detail=checks)
    return {"status": "ok", **checks}
