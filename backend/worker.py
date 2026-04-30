import asyncio

from app.worker import retry_worker


if __name__ == "__main__":
    asyncio.run(retry_worker())
