
async def enqueue_retry(request_id: str, destination_url: str, attempt_number: int):
    if attempt_number >= 5:
        return
    delay_seconds = 5 ** attempt_number
    execute_at = time.time() + delay_seconds
    job = json.dumps({
        "request_id": request_id,
        "destination_url": destination_url,
        "attempt_number": attempt_number,
        "execute_at": execute_at,
    })
    await redis_client.zadd("retry_queue", {job: execute_at})
