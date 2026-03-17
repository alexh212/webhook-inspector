import json
import time
import ipaddress
import socket
import logging
from urllib.parse import urlparse

import redis.asyncio as aioredis

logger = logging.getLogger("webhookinspector")

BLOCKED_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.0.0.0/24"),
    ipaddress.ip_network("192.0.2.0/24"),
    ipaddress.ip_network("192.88.99.0/24"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("198.18.0.0/15"),
    ipaddress.ip_network("198.51.100.0/24"),
    ipaddress.ip_network("203.0.113.0/24"),
    ipaddress.ip_network("224.0.0.0/4"),
    ipaddress.ip_network("240.0.0.0/4"),
    ipaddress.ip_network("255.255.255.255/32"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("ff00::/8"),
    ipaddress.ip_network("::ffff:127.0.0.0/104"),
    ipaddress.ip_network("::ffff:10.0.0.0/104"),
    ipaddress.ip_network("::ffff:172.16.0.0/108"),
    ipaddress.ip_network("::ffff:192.168.0.0/112"),
]

MAX_RETRIES = 5


def validate_destination_url(url: str) -> None:
    """Raise ValueError if the URL targets a private/reserved IP or uses a bad scheme."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Unsupported scheme: {parsed.scheme}")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("Missing hostname")

    try:
        infos = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError(f"Cannot resolve hostname: {hostname}") from exc

    for family, _, _, _, sockaddr in infos:
        ip = ipaddress.ip_address(sockaddr[0])
        for network in BLOCKED_NETWORKS:
            if ip in network:
                raise ValueError(f"Destination resolves to blocked address: {ip}")


async def enqueue_retry(
    redis_client: aioredis.Redis,
    request_id: str,
    destination_url: str,
    attempt_number: int,
) -> None:
    if attempt_number >= MAX_RETRIES:
        logger.info("Max retries (%d) reached for request %s", MAX_RETRIES, request_id)
        return
    delay = 5 ** attempt_number
    job = json.dumps({
        "request_id": request_id,
        "destination_url": destination_url,
        "attempt_number": attempt_number,
    })
    await redis_client.zadd("retry_queue", {job: time.time() + delay})
    logger.info("Retry %d queued for request %s in %ds", attempt_number, request_id, delay)
