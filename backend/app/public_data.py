"""Relays for PUBLIC mutual-fund data that browsers cannot fetch directly (CORS).

No user data is sent anywhere: the browser asks for the public AMFI NAV file or a scheme's public
NAV history, and the server fetches and caches it. Session auth is still required so the server
is not an open proxy.
"""

import json
import re
import threading
import time
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response

from .auth import require_auth
from .settings import Settings, get_settings
from .storage import atomic_write_bytes, read_json, write_json

router = APIRouter(prefix="/api/public", tags=["public"], dependencies=[Depends(require_auth)])
_lock = threading.Lock()

AMFI_MAX_AGE_SECONDS = 6 * 3600
HISTORY_MAX_AGE_SECONDS = 20 * 3600
MAX_BYTES = 20 * 1024 * 1024


def fetch_bytes(url: str) -> bytes:
    """Download a public URL (patched in tests)."""
    with httpx.Client(timeout=60, follow_redirects=True) as c:
        r = c.get(url, headers={"User-Agent": "Artha/1.0 (personal finance; NAV relay)"})
        r.raise_for_status()
        if len(r.content) > MAX_BYTES:
            raise ValueError("Response too large")
        return r.content


def _cache_dir(settings: Settings):
    d = settings.data_dir / "cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _fresh(meta: dict | None, max_age: int) -> bool:
    return bool(meta) and time.time() - meta.get("fetched_at", 0) < max_age


@router.get("/amfi-nav")
def amfi_nav(force: bool = False, settings: Settings = Depends(get_settings)):
    d = _cache_dir(settings)
    path, meta_path = d / "NAVAll.txt", d / "NAVAll.meta.json"
    with _lock:
        meta = read_json(meta_path)
        state = "hit"
        # `force` may refetch at most every 10 minutes.
        if not path.exists() or not _fresh(meta, 600 if force else AMFI_MAX_AGE_SECONDS):
            try:
                data = fetch_bytes(settings.amfi_nav_url)
                if b";" not in data[:2000]:
                    raise ValueError("Unexpected AMFI response")
                atomic_write_bytes(path, data, mode=0o644)
                meta = {"fetched_at": time.time()}
                write_json(meta_path, meta)
                state = "refreshed"
            except Exception as e:  # noqa: BLE001
                if not path.exists():
                    raise HTTPException(502, f"Could not download AMFI NAV file: {e}") from e
                state = "stale"
        body = path.read_bytes()
    fetched = datetime.fromtimestamp((meta or {}).get("fetched_at", 0)).isoformat()
    return Response(
        content=body,
        media_type="text/plain; charset=utf-8",
        headers={"X-Cache": state, "X-Fetched-At": fetched},
    )


_CODE_RE = re.compile(r"^\d{3,8}$")


@router.get("/nav-history/{scheme_code}")
def nav_history(scheme_code: str, settings: Settings = Depends(get_settings)):
    if settings.nav_history_provider == "none":
        raise HTTPException(404, "Historical NAV provider is disabled")
    if not _CODE_RE.match(scheme_code):
        raise HTTPException(400, "Invalid scheme code")
    d = _cache_dir(settings) / "nav"
    d.mkdir(exist_ok=True)
    path = d / f"{scheme_code}.json"
    with _lock:
        cached = read_json(path)
        if cached and _fresh(cached, HISTORY_MAX_AGE_SECONDS):
            return cached["payload"]
    try:
        raw = json.loads(fetch_bytes(f"{settings.mfapi_base_url.rstrip('/')}/{scheme_code}"))
        payload = normalise_mfapi(scheme_code, raw)
    except Exception as e:  # noqa: BLE001 - provider is unofficial; degrade gracefully
        if cached:
            return cached["payload"]
        raise HTTPException(502, f"Historical NAV provider failed: {e}") from e
    with _lock:
        write_json(path, {"fetched_at": time.time(), "payload": payload})
    return payload


def normalise_mfapi(scheme_code: str, raw: dict) -> dict:
    """mfapi.in JSON → {schemeCode, schemeName, data: [{date: YYYY-MM-DD, nav}]}, oldest first."""
    if not isinstance(raw, dict) or not isinstance(raw.get("data"), list):
        raise ValueError("Unexpected provider response")
    points = []
    for row in raw["data"]:
        try:
            dd, mm, yyyy = row["date"].split("-")
            nav = str(row["nav"]).strip()
            if float(nav) <= 0:
                continue
            points.append({"date": f"{yyyy}-{mm}-{dd}", "nav": nav})
        except (KeyError, ValueError, AttributeError):
            continue
    points.sort(key=lambda p: p["date"])
    meta = raw.get("meta") or {}
    return {"schemeCode": scheme_code, "schemeName": meta.get("scheme_name"), "data": points}
