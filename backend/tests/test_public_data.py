from app import public_data

SAMPLE = (
    b"Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;"
    b"Net Asset Value;Date\n\nHDFC Mutual Fund\n"
    b"118955;INF179K01UT0;-;HDFC Flexi Cap Fund - Direct Plan - Growth;1950.1234;03-Oct-2026\n"
)


def test_requires_auth(client):
    assert client.get("/api/public/amfi-nav").status_code == 401


def test_amfi_relay_caches_and_serves_stale(authed, monkeypatch):
    client, _ = authed
    calls = []

    def fake_fetch(url):
        calls.append(url)
        return SAMPLE

    monkeypatch.setattr(public_data, "fetch_bytes", fake_fetch)
    r = client.get("/api/public/amfi-nav")
    assert r.status_code == 200 and r.content == SAMPLE
    assert r.headers["x-cache"] == "refreshed"
    r = client.get("/api/public/amfi-nav")
    assert r.headers["x-cache"] == "hit" and len(calls) == 1

    # Expired cache + provider down → stale copy, not an error.
    monkeypatch.setattr(public_data, "AMFI_MAX_AGE_SECONDS", -1)

    def broken(url):
        raise RuntimeError("down")

    monkeypatch.setattr(public_data, "fetch_bytes", broken)
    r = client.get("/api/public/amfi-nav")
    assert r.status_code == 200 and r.headers["x-cache"] == "stale"


def test_amfi_relay_no_cache_and_failure_is_502(authed, monkeypatch):
    client, _ = authed
    monkeypatch.setattr(public_data, "fetch_bytes", lambda url: b"<html>maintenance</html>")
    assert client.get("/api/public/amfi-nav").status_code == 502


def test_nav_history_normalises_and_validates(authed, monkeypatch, settings):
    client, _ = authed
    payload = (
        b'{"meta":{"scheme_name":"HDFC Flexi Cap"},"data":['
        b'{"date":"03-10-2026","nav":"1950.12340"},{"date":"01-10-2026","nav":"1940.00000"},'
        b'{"date":"bad","nav":"x"}]}'
    )
    monkeypatch.setattr(public_data, "fetch_bytes", lambda url: payload)
    assert client.get("/api/public/nav-history/abc").status_code == 400
    r = client.get("/api/public/nav-history/118955")
    assert r.status_code == 200
    assert r.json() == {
        "schemeCode": "118955",
        "schemeName": "HDFC Flexi Cap",
        "data": [
            {"date": "2026-10-01", "nav": "1940.00000"},
            {"date": "2026-10-03", "nav": "1950.12340"},
        ],
    }
    settings.nav_history_provider = "none"
    assert client.get("/api/public/nav-history/118955").status_code == 404
