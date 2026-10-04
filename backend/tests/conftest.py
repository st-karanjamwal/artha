import pyotp
import pytest
from fastapi.testclient import TestClient

from app import auth
from app.main import create_app
from app.settings import Settings, get_settings

SETUP_TOKEN = "test-setup-token"
PASSWORD = "correct horse battery"
H = {"X-Artha-Request": "1"}


@pytest.fixture
def settings(tmp_path):
    return Settings(data_dir=tmp_path, setup_token=SETUP_TOKEN, cookie_secure=False)


@pytest.fixture
def client(settings):
    auth.sessions.revoke_all()
    auth.limiter.clear()
    app = create_app()
    app.dependency_overrides[get_settings] = lambda: settings
    with TestClient(app) as c:
        yield c


def next_code(secret: str, offset_steps: int = 0) -> str:
    import time

    return pyotp.TOTP(secret).at(int(time.time()) + 30 * offset_steps)


@pytest.fixture
def authed(client):
    """Client that has completed setup and holds a session cookie. Returns (client, secret)."""
    r = client.post(
        "/api/auth/setup", json={"setup_token": SETUP_TOKEN, "password": PASSWORD}, headers=H
    )
    assert r.status_code == 200, r.text
    secret = r.json()["secret"]
    r = client.post(
        "/api/auth/setup/confirm",
        json={"setup_token": SETUP_TOKEN, "code": next_code(secret)},
        headers=H,
    )
    assert r.status_code == 200, r.text
    return client, secret
