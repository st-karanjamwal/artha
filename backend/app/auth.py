"""Server login: Argon2 password + mandatory TOTP, HttpOnly session cookie.

This protects access to the encrypted blob. It is independent of the vault passphrase,
which never reaches the server.
"""

import hashlib
import hmac
import secrets
import threading
import time
from collections import deque
from datetime import UTC, datetime

import pyotp
import segno
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .settings import Settings, get_settings
from .storage import read_json, write_json

COOKIE_NAME = "artha_session"
MIN_PASSWORD_LEN = 12

router = APIRouter(prefix="/api/auth", tags=["auth"])
_ph = PasswordHasher()
_lock = threading.Lock()


# ---------------------------------------------------------------- persistence


def _auth_path(settings: Settings):
    return settings.data_dir / "auth.json"


def load_auth(settings: Settings) -> dict:
    return read_json(_auth_path(settings), default={}) or {}


def save_auth(settings: Settings, data: dict) -> None:
    write_json(_auth_path(settings), data)


def is_setup_complete(settings: Settings) -> bool:
    return bool(load_auth(settings).get("totp_confirmed"))


# ---------------------------------------------------------------- sessions (in memory)


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, float] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _key(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def create(self, ttl_seconds: int) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._sessions[self._key(token)] = time.time() + ttl_seconds
        return token

    def valid(self, token: str | None) -> bool:
        if not token:
            return False
        key = self._key(token)
        with self._lock:
            exp = self._sessions.get(key)
            if exp is None:
                return False
            if exp < time.time():
                del self._sessions[key]
                return False
            return True

    def revoke(self, token: str | None) -> None:
        if token:
            with self._lock:
                self._sessions.pop(self._key(token), None)

    def revoke_all(self) -> None:
        with self._lock:
            self._sessions.clear()


sessions = SessionStore()


# ---------------------------------------------------------------- rate limiting


class RateLimiter:
    """Counts failed attempts per client IP and globally within a sliding window."""

    def __init__(self) -> None:
        self._per_ip: dict[str, deque[float]] = {}
        self._global: deque[float] = deque()
        self._lock = threading.Lock()

    @staticmethod
    def _trim(q: deque[float], window: float, now: float) -> None:
        while q and q[0] < now - window:
            q.popleft()

    def retry_after(self, ip: str, settings: Settings) -> int:
        """Seconds until the client may try again; 0 when allowed."""
        window = settings.login_window_minutes * 60
        now = time.time()
        with self._lock:
            q = self._per_ip.get(ip, deque())
            self._trim(q, window, now)
            self._trim(self._global, window, now)
            waits = []
            if len(q) >= settings.login_max_failures:
                waits.append(q[0] + window - now)
            if len(self._global) >= settings.login_global_max_failures:
                waits.append(self._global[0] + window - now)
            return int(max(waits)) + 1 if waits else 0

    def fail(self, ip: str) -> None:
        now = time.time()
        with self._lock:
            self._per_ip.setdefault(ip, deque()).append(now)
            self._global.append(now)

    def reset(self, ip: str) -> None:
        with self._lock:
            self._per_ip.pop(ip, None)

    def clear(self) -> None:
        with self._lock:
            self._per_ip.clear()
            self._global.clear()


limiter = RateLimiter()


def client_ip(request: Request, settings: Settings) -> str:
    if settings.trust_proxy:
        real = request.headers.get("x-real-ip")
        if real:
            return real
    return request.client.host if request.client else "unknown"


# ---------------------------------------------------------------- helpers


def _verify_password(stored_hash: str, password: str) -> bool:
    try:
        return _ph.verify(stored_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def _verify_totp(data: dict, code: str, settings: Settings) -> bool:
    """Verify a TOTP code with ±1 step tolerance and replay protection."""
    secret = data.get("totp_secret")
    if not secret or not code or not code.isdigit():
        return False
    totp = pyotp.TOTP(secret)
    now = int(time.time())
    last_used = data.get("totp_last_step", -1)
    for offset in (-1, 0, 1):
        step = now // 30 + offset
        if step <= last_used:
            continue
        if hmac.compare_digest(totp.at(step * 30), code):
            data["totp_last_step"] = step
            return True
    return False


def _set_session_cookie(response: Response, settings: Settings) -> None:
    ttl = settings.session_ttl_hours * 3600
    token = sessions.create(ttl)
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=ttl,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        path="/api",
    )


def require_auth(request: Request) -> None:
    if not sessions.valid(request.cookies.get(COOKIE_NAME)):
        raise HTTPException(status_code=401, detail="Not authenticated")


# ---------------------------------------------------------------- models


class SetupStart(BaseModel):
    setup_token: str
    password: str = Field(min_length=MIN_PASSWORD_LEN, max_length=256)


class SetupConfirm(BaseModel):
    setup_token: str
    code: str


class LoginBody(BaseModel):
    password: str = Field(max_length=256)
    code: str = Field(max_length=10)


class ChangePassword(BaseModel):
    current_password: str = Field(max_length=256)
    new_password: str = Field(min_length=MIN_PASSWORD_LEN, max_length=256)
    code: str = Field(max_length=10)


# ---------------------------------------------------------------- routes


@router.get("/status")
def status(request: Request, settings: Settings = Depends(get_settings)):
    return {
        "setup_complete": is_setup_complete(settings),
        "authenticated": sessions.valid(request.cookies.get(COOKIE_NAME)),
    }


def _check_setup_token(token: str, settings: Settings) -> None:
    if not settings.setup_token:
        raise HTTPException(503, "Server has no ARTHA_SETUP_TOKEN configured")
    if not hmac.compare_digest(token.encode(), settings.setup_token.encode()):
        raise HTTPException(403, "Invalid setup token")


@router.post("/setup")
def setup_start(body: SetupStart, request: Request, settings: Settings = Depends(get_settings)):
    ip = client_ip(request, settings)
    if wait := limiter.retry_after(ip, settings):
        raise HTTPException(429, f"Too many attempts. Try again in {wait}s")
    with _lock:
        if is_setup_complete(settings):
            raise HTTPException(409, "Setup already completed")
        try:
            _check_setup_token(body.setup_token, settings)
        except HTTPException:
            limiter.fail(ip)
            raise
        secret = pyotp.random_base32()
        save_auth(
            settings,
            {
                "password_hash": _ph.hash(body.password),
                "totp_secret": secret,
                "totp_confirmed": False,
                "created_on": datetime.now(UTC).isoformat(),
            },
        )
    uri = pyotp.TOTP(secret).provisioning_uri(name="owner", issuer_name="Artha")
    qr_svg = segno.make(uri, error="m").svg_data_uri(scale=5, border=2)
    return {"otpauth_uri": uri, "secret": secret, "qr_svg": qr_svg}


@router.post("/setup/confirm")
def setup_confirm(
    body: SetupConfirm,
    request: Request,
    response: Response,
    settings: Settings = Depends(get_settings),
):
    ip = client_ip(request, settings)
    if wait := limiter.retry_after(ip, settings):
        raise HTTPException(429, f"Too many attempts. Try again in {wait}s")
    with _lock:
        data = load_auth(settings)
        if data.get("totp_confirmed"):
            raise HTTPException(409, "Setup already completed")
        if not data.get("totp_secret"):
            raise HTTPException(400, "Start setup first")
        try:
            _check_setup_token(body.setup_token, settings)
        except HTTPException:
            limiter.fail(ip)
            raise
        if not _verify_totp(data, body.code.strip(), settings):
            limiter.fail(ip)
            raise HTTPException(400, "Invalid code")
        data["totp_confirmed"] = True
        save_auth(settings, data)
    _set_session_cookie(response, settings)
    return {"ok": True}


@router.post("/login")
def login(
    body: LoginBody,
    request: Request,
    response: Response,
    settings: Settings = Depends(get_settings),
):
    ip = client_ip(request, settings)
    if wait := limiter.retry_after(ip, settings):
        raise HTTPException(429, f"Too many attempts. Try again in {wait}s")
    with _lock:
        data = load_auth(settings)
        if not data.get("totp_confirmed"):
            raise HTTPException(409, "Setup not completed")
        # Always evaluate both factors so the response does not reveal which one failed.
        pw_ok = _verify_password(data["password_hash"], body.password)
        totp_ok = _verify_totp(data, body.code.strip(), settings) if pw_ok else False
        if not (pw_ok and totp_ok):
            limiter.fail(ip)
            raise HTTPException(401, "Invalid password or code")
        save_auth(settings, data)  # persist TOTP replay marker
    limiter.reset(ip)
    _set_session_cookie(response, settings)
    return {"ok": True}


@router.post("/logout")
def logout(request: Request, response: Response):
    sessions.revoke(request.cookies.get(COOKIE_NAME))
    response.delete_cookie(COOKIE_NAME, path="/api")
    return {"ok": True}


@router.post("/password", dependencies=[Depends(require_auth)])
def change_password(
    body: ChangePassword,
    request: Request,
    response: Response,
    settings: Settings = Depends(get_settings),
):
    ip = client_ip(request, settings)
    if wait := limiter.retry_after(ip, settings):
        raise HTTPException(429, f"Too many attempts. Try again in {wait}s")
    with _lock:
        data = load_auth(settings)
        pw_ok = _verify_password(data["password_hash"], body.current_password)
        if not (pw_ok and _verify_totp(data, body.code.strip(), settings)):
            limiter.fail(ip)
            raise HTTPException(401, "Invalid password or code")
        data["password_hash"] = _ph.hash(body.new_password)
        save_auth(settings, data)
    sessions.revoke_all()
    _set_session_cookie(response, settings)
    return {"ok": True}
