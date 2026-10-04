"""Upload the (already encrypted) vault blob to the owner's Google Drive.

Uses an OAuth refresh token with the `drive.file` scope, so Artha can only see files it
created. Only the opaque encrypted blob ever leaves the server.
"""

import asyncio
import hashlib
import json
import logging
import re
import threading
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Depends, HTTPException

from .auth import require_auth
from .settings import Settings, get_settings
from .storage import read_json, write_json
from .vault import VaultStore

log = logging.getLogger("artha.backup")
router = APIRouter(prefix="/api/backup", tags=["backup"], dependencies=[Depends(require_auth)])
_run_lock = threading.Lock()

TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105
FILES_URL = "https://www.googleapis.com/drive/v3/files"
UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart"
NAME_RE = re.compile(r"^artha_(\d{4})-(\d{2})-(\d{2})_(\d{4})\.vault$")


# ---------------------------------------------------------------- retention (pure)


def select_for_deletion(names: list[str], keep_daily: int, keep_monthly: int) -> list[str]:
    """Keep the newest file of each of the last `keep_daily` days and the newest file of
    each of the last `keep_monthly` months. Return names to delete. Unknown names are kept."""
    dated = sorted((n for n in names if NAME_RE.match(n)), reverse=True)  # newest first
    keep: set[str] = set()
    days: list[str] = []
    months: list[str] = []
    for n in dated:
        y, mo, d, _ = NAME_RE.match(n).groups()
        day, month = f"{y}-{mo}-{d}", f"{y}-{mo}"
        if day not in days:
            days.append(day)
            if len(days) <= keep_daily:
                keep.add(n)
        if month not in months:
            months.append(month)
            if len(months) <= keep_monthly:
                keep.add(n)
    return [n for n in dated if n not in keep]


def backup_name(now: datetime) -> str:
    return f"artha_{now:%Y-%m-%d_%H%M}.vault"


# ---------------------------------------------------------------- drive client


class DriveClient:
    def __init__(self, settings: Settings, client: httpx.Client | None = None) -> None:
        self.s = settings
        self.http = client or httpx.Client(timeout=60)

    def _token(self) -> str:
        r = self.http.post(
            TOKEN_URL,
            data={
                "client_id": self.s.gdrive_client_id,
                "client_secret": self.s.gdrive_client_secret,
                "refresh_token": self.s.gdrive_refresh_token,
                "grant_type": "refresh_token",
            },
        )
        r.raise_for_status()
        return r.json()["access_token"]

    def upload(self, token: str, name: str, data: bytes) -> str:
        boundary = "artha" + hashlib.sha256(data[:64]).hexdigest()[:16]
        metadata = json.dumps(
            {
                "name": name,
                "parents": [self.s.gdrive_folder_id],
                "mimeType": "application/octet-stream",
            }
        )
        body = (
            (
                f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
                f"{metadata}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n"
            ).encode()
            + data
            + f"\r\n--{boundary}--".encode()
        )
        r = self.http.post(
            UPLOAD_URL,
            content=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": f"multipart/related; boundary={boundary}",
            },
        )
        r.raise_for_status()
        return r.json()["id"]

    def list_backups(self, token: str) -> list[dict]:
        files, page = [], None
        while True:
            params = {
                "q": f"'{self.s.gdrive_folder_id}' in parents and trashed = false",
                "fields": "nextPageToken, files(id, name)",
                "pageSize": 1000,
            }
            if page:
                params["pageToken"] = page
            r = self.http.get(
                FILES_URL, params=params, headers={"Authorization": f"Bearer {token}"}
            )
            r.raise_for_status()
            j = r.json()
            files += j.get("files", [])
            page = j.get("nextPageToken")
            if not page:
                return files

    def delete(self, token: str, file_id: str) -> None:
        r = self.http.delete(f"{FILES_URL}/{file_id}", headers={"Authorization": f"Bearer {token}"})
        if r.status_code not in (204, 404):
            r.raise_for_status()


# ---------------------------------------------------------------- job


def _state_path(settings: Settings):
    return settings.data_dir / "backup_state.json"


def load_state(settings: Settings) -> dict:
    return read_json(_state_path(settings), default={}) or {}


def run_backup(settings: Settings, force: bool = False, client: DriveClient | None = None) -> dict:
    if not settings.gdrive_configured:
        raise RuntimeError("Google Drive backup is not configured")
    with _run_lock:
        state = load_state(settings)
        state["last_run"] = datetime.now(UTC).isoformat()
        store = VaultStore(settings)
        path = store.current_path()
        if not path:
            state["last_result"] = "skipped: no vault yet"
            write_json(_state_path(settings), state)
            return state
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if not force and digest == state.get("last_sha256"):
            state["last_result"] = "skipped: unchanged since last backup"
            write_json(_state_path(settings), state)
            return state
        drive = client or DriveClient(settings)
        try:
            token = drive._token()
            name = backup_name(datetime.now(ZoneInfo(settings.timezone)))
            drive.upload(token, name, data)
            files = drive.list_backups(token)
            to_delete = set(
                select_for_deletion(
                    [f["name"] for f in files],
                    settings.backup_keep_daily,
                    settings.backup_keep_monthly,
                )
            )
            for f in files:
                if f["name"] in to_delete:
                    drive.delete(token, f["id"])
            state.update(
                last_success=state["last_run"],
                last_file=name,
                last_sha256=digest,
                last_blob_version=store.current_version(),
                last_result=f"uploaded {name}, pruned {len(to_delete)}",
                last_error=None,
            )
        except Exception as e:  # noqa: BLE001 - report any failure in status
            log.exception("Backup failed")
            state["last_error"] = f"{type(e).__name__}: {e}"[:500]
            state["last_result"] = "failed"
        write_json(_state_path(settings), state)
        return state


def seconds_until_next(settings: Settings, now: datetime | None = None) -> float:
    tz = ZoneInfo(settings.timezone)
    now = now or datetime.now(tz)
    hh, mm = (int(x) for x in settings.backup_time.split(":"))
    target = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


async def scheduler_loop(settings: Settings) -> None:
    while True:
        await asyncio.sleep(seconds_until_next(settings))
        if settings.gdrive_configured:
            await asyncio.to_thread(run_backup, settings)


# ---------------------------------------------------------------- routes


@router.get("/status")
def backup_status(settings: Settings = Depends(get_settings)):
    state = load_state(settings)
    state.pop("last_sha256", None)
    return {
        "configured": settings.gdrive_configured,
        "schedule": f"daily {settings.backup_time} {settings.timezone}",
        "retention": f"{settings.backup_keep_daily} daily + {settings.backup_keep_monthly} monthly",
        **state,
    }


@router.post("/run")
async def backup_run(settings: Settings = Depends(get_settings)):
    if not settings.gdrive_configured:
        raise HTTPException(400, "Google Drive backup is not configured on the server")
    state = await asyncio.to_thread(run_backup, settings, True)
    state.pop("last_sha256", None)
    if state.get("last_result") == "failed":
        raise HTTPException(502, state.get("last_error") or "Backup failed")
    return state
