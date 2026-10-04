"""Opaque encrypted vault blob storage with optimistic locking and version history.

The server never parses beyond the magic prefix; it cannot decrypt the blob.
"""

import hashlib
import re
import threading
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse

from .auth import require_auth
from .settings import Settings, get_settings
from .storage import atomic_write_bytes, read_json, write_json

MAGIC = b"ARTHA1"
_VERSION_RE = re.compile(r"^(\d{8})\.vault$")

router = APIRouter(prefix="/api/vault", tags=["vault"], dependencies=[Depends(require_auth)])
_lock = threading.Lock()


class VaultStore:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.root = settings.data_dir / "vault"
        self.versions_dir = self.root / "versions"
        self.meta_path = self.root / "meta.json"

    def meta(self) -> dict | None:
        return read_json(self.meta_path)

    def current_version(self) -> int:
        m = self.meta()
        return int(m["blob_version"]) if m else 0

    def path_for(self, version: int) -> Path:
        return self.versions_dir / f"{version:08d}.vault"

    def current_path(self) -> Path | None:
        v = self.current_version()
        return self.path_for(v) if v else None

    def list_versions(self) -> list[dict]:
        if not self.versions_dir.exists():
            return []
        out = []
        for p in self.versions_dir.iterdir():
            m = _VERSION_RE.match(p.name)
            if m:
                st = p.stat()
                out.append(
                    {
                        "blob_version": int(m.group(1)),
                        "saved_on": datetime.fromtimestamp(st.st_mtime, UTC).isoformat(),
                        "size": st.st_size,
                    }
                )
        return sorted(out, key=lambda x: x["blob_version"], reverse=True)

    def write_new(self, data: bytes) -> dict:
        """Store `data` as the next version. Caller must hold the lock."""
        version = self.current_version() + 1
        atomic_write_bytes(self.path_for(version), data)
        meta = {
            "blob_version": version,
            "updated_on": datetime.now(UTC).isoformat(),
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
        write_json(self.meta_path, meta)
        self._prune()
        return meta

    def _prune(self) -> None:
        for v in self.list_versions()[self.settings.keep_versions :]:
            self.path_for(v["blob_version"]).unlink(missing_ok=True)


def get_store(settings: Settings = Depends(get_settings)) -> VaultStore:
    return VaultStore(settings)


def _parse_if_match(request: Request) -> int:
    raw = request.headers.get("if-match")
    if raw is None:
        raise HTTPException(428, "If-Match header with blob version is required")
    raw = raw.strip().removeprefix("W/").strip('"')
    if not raw.isdigit():
        raise HTTPException(400, "If-Match must be a blob version number")
    return int(raw)


def _public_meta(meta: dict | None) -> dict:
    if not meta:
        return {"exists": False, "blob_version": 0}
    return {
        "exists": True,
        "blob_version": meta["blob_version"],
        "updated_on": meta["updated_on"],
        "size": meta["size"],
    }


@router.get("/meta")
def vault_meta(store: VaultStore = Depends(get_store)):
    return _public_meta(store.meta())


@router.get("")
def get_vault(store: VaultStore = Depends(get_store)):
    with _lock:
        meta = store.meta()
        if not meta:
            raise HTTPException(404, "No vault yet")
        version = meta["blob_version"]
        data = store.path_for(version).read_bytes()
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "ETag": f'"{version}"',
            "X-Blob-Version": str(version),
            "Cache-Control": "no-store",
        },
    )


@router.put("")
async def put_vault(
    request: Request,
    store: VaultStore = Depends(get_store),
    settings: Settings = Depends(get_settings),
):
    expected = _parse_if_match(request)
    length = request.headers.get("content-length")
    if length and int(length) > settings.max_vault_bytes:
        raise HTTPException(413, "Vault too large")
    data = await request.body()
    if len(data) > settings.max_vault_bytes:
        raise HTTPException(413, "Vault too large")
    if not data.startswith(MAGIC):
        raise HTTPException(400, "Not an Artha vault blob")
    with _lock:
        current = store.current_version()
        if expected != current:
            raise HTTPException(
                409, detail={"message": "Vault changed elsewhere", "current_version": current}
            )
        meta = store.write_new(data)
    return _public_meta(meta)


@router.get("/versions")
def list_versions(store: VaultStore = Depends(get_store)):
    return {"current_version": store.current_version(), "versions": store.list_versions()}


@router.get("/versions/{version}")
def download_version(version: int, store: VaultStore = Depends(get_store)):
    p = store.path_for(version)
    if not p.exists():
        raise HTTPException(404, "Version not found")
    return FileResponse(
        p,
        media_type="application/octet-stream",
        filename=f"artha_v{version}.vault",
        headers={"Cache-Control": "no-store"},
    )


@router.post("/restore/{version}")
def restore_version(version: int, store: VaultStore = Depends(get_store)):
    """Copy an old version forward as the newest version (history is never rewritten)."""
    with _lock:
        p = store.path_for(version)
        if not p.exists():
            raise HTTPException(404, "Version not found")
        meta = store.write_new(p.read_bytes())
    return _public_meta(meta)
