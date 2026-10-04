from .conftest import H

BLOB = b"ARTHA1" + b"\x00" * 20


def put(client, data, version):
    return client.put("/api/vault", content=data, headers={**H, "If-Match": str(version)})


def test_requires_auth(client):
    assert client.get("/api/vault").status_code == 401
    assert put(client, BLOB, 0).status_code == 401


def test_empty_vault(authed):
    client, _ = authed
    assert client.get("/api/vault/meta").json() == {"exists": False, "blob_version": 0}
    assert client.get("/api/vault").status_code == 404


def test_put_get_roundtrip(authed):
    client, _ = authed
    r = put(client, BLOB, 0)
    assert r.status_code == 200, r.text
    assert r.json()["blob_version"] == 1
    r = client.get("/api/vault")
    assert r.content == BLOB
    assert r.headers["x-blob-version"] == "1"


def test_if_match_required_and_conflict(authed):
    client, _ = authed
    assert client.put("/api/vault", content=BLOB, headers=H).status_code == 428
    assert put(client, BLOB, 0).status_code == 200
    r = put(client, BLOB + b"x", 0)  # stale version
    assert r.status_code == 409
    assert r.json()["detail"]["current_version"] == 1
    assert put(client, BLOB + b"x", 1).status_code == 200


def test_rejects_non_vault(authed):
    client, _ = authed
    assert put(client, b"plaintext sqlite", 0).status_code == 400


def test_versions_prune_and_restore(authed, settings):
    client, _ = authed
    settings.keep_versions = 3
    for i in range(5):
        assert put(client, BLOB + bytes([i]), i).status_code == 200
    vs = client.get("/api/vault/versions").json()
    assert vs["current_version"] == 5
    assert [v["blob_version"] for v in vs["versions"]] == [5, 4, 3]

    r = client.post("/api/vault/restore/3", headers=H)
    assert r.status_code == 200
    assert r.json()["blob_version"] == 6
    assert client.get("/api/vault").content == BLOB + bytes([2])
    assert client.post("/api/vault/restore/1", headers=H).status_code == 404
