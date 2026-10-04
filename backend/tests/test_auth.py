from .conftest import PASSWORD, SETUP_TOKEN, H, next_code


def test_status_before_setup(client):
    assert client.get("/api/auth/status").json() == {
        "setup_complete": False,
        "authenticated": False,
    }


def test_setup_requires_token(client):
    r = client.post(
        "/api/auth/setup", json={"setup_token": "nope", "password": PASSWORD}, headers=H
    )
    assert r.status_code == 403


def test_setup_rejects_short_password(client):
    r = client.post(
        "/api/auth/setup", json={"setup_token": SETUP_TOKEN, "password": "short"}, headers=H
    )
    assert r.status_code == 422


def test_setup_flow_and_cannot_repeat(authed):
    client, _ = authed
    assert client.get("/api/auth/status").json() == {
        "setup_complete": True,
        "authenticated": True,
    }
    r = client.post(
        "/api/auth/setup", json={"setup_token": SETUP_TOKEN, "password": PASSWORD}, headers=H
    )
    assert r.status_code == 409


def test_csrf_header_required(client):
    r = client.post("/api/auth/login", json={"password": "x", "code": "1"})
    assert r.status_code == 403


def test_login_logout(authed):
    client, secret = authed
    client.post("/api/auth/logout", headers=H)
    assert client.get("/api/auth/status").json()["authenticated"] is False
    assert client.get("/api/vault/meta").status_code == 401

    r = client.post(
        "/api/auth/login", json={"password": PASSWORD, "code": next_code(secret, 1)}, headers=H
    )
    assert r.status_code == 200, r.text
    assert client.get("/api/vault/meta").status_code == 200


def test_login_wrong_password_and_totp_replay(authed):
    client, secret = authed
    client.post("/api/auth/logout", headers=H)
    r = client.post(
        "/api/auth/login", json={"password": "wrong password!!", "code": "000000"}, headers=H
    )
    assert r.status_code == 401
    # The code used during setup confirm (current step) must not be reusable.
    r = client.post(
        "/api/auth/login", json={"password": PASSWORD, "code": next_code(secret)}, headers=H
    )
    assert r.status_code == 401


def test_login_lockout(authed):
    client, secret = authed
    client.post("/api/auth/logout", headers=H)
    for _ in range(5):
        client.post(
            "/api/auth/login", json={"password": "bad password 123", "code": "123456"}, headers=H
        )
    r = client.post(
        "/api/auth/login", json={"password": PASSWORD, "code": next_code(secret, 1)}, headers=H
    )
    assert r.status_code == 429
