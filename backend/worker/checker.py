import ipaddress
import socket
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlparse

import httpx


@dataclass(frozen=True)
class CheckResult:
    status: str
    http_status: int | None
    response_time_ms: int
    checked_at: datetime


def host_is_public(hostname: str) -> bool:
    try:
        addresses = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return False
    ips = {ipaddress.ip_address(address[4][0]) for address in addresses}
    return bool(ips) and all(ip.is_global for ip in ips)


def check_url(url: str, timeout_seconds: float) -> CheckResult:
    started = time.perf_counter()
    checked_at = datetime.now(UTC)
    hostname = urlparse(url).hostname
    if not hostname or not host_is_public(hostname):
        return CheckResult("DOWN", None, 0, checked_at)
    try:
        with httpx.Client(
            timeout=timeout_seconds,
            follow_redirects=False,
            headers={"User-Agent": "small-uptime-monitor/1.0"},
        ) as client:
            response = client.get(url)
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        state = "UP" if response.status_code < 500 else "DOWN"
        return CheckResult(state, response.status_code, elapsed_ms, checked_at)
    except httpx.HTTPError:
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        return CheckResult("DOWN", None, elapsed_ms, checked_at)

