"""Obtain a Google Drive OAuth refresh token for Artha backups (run once, on your laptop).

1. In Google Cloud Console create a project, enable the "Google Drive API", and create an
   OAuth client ID of type "Desktop app". Note the client ID and secret.
2. Run:  python scripts/gdrive_auth.py <CLIENT_ID> <CLIENT_SECRET>
3. A browser opens; sign in with the Google account that should hold the backups.
4. Copy the printed ARTHA_GDRIVE_* lines into the server's .env.

Scope is drive.file: Artha can only see files it created, nothing else in your Drive.
Only the standard library and httpx are used.
"""

import base64
import hashlib
import http.server
import secrets
import sys
import threading
import urllib.parse
import webbrowser

import httpx

SCOPE = "https://www.googleapis.com/auth/drive.file"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105
FILES_URL = "https://www.googleapis.com/drive/v3/files"


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    client_id, client_secret = sys.argv[1], sys.argv[2]
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=")
    state = secrets.token_urlsafe(16)
    result: dict[str, str] = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
            if q.get("state") == state and "code" in q:
                result["code"] = q["code"]
                body = b"Artha: authorisation received. You can close this tab."
            else:
                body = b"Artha: authorisation failed."
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    redirect = f"http://127.0.0.1:{server.server_port}"
    url = (
        AUTH_URL
        + "?"
        + urllib.parse.urlencode(
            {
                "client_id": client_id,
                "redirect_uri": redirect,
                "response_type": "code",
                "scope": SCOPE,
                "access_type": "offline",
                "prompt": "consent",
                "state": state,
                "code_challenge": challenge.decode(),
                "code_challenge_method": "S256",
            }
        )
    )
    t = threading.Thread(target=server.handle_request)
    t.start()
    print("Opening browser for Google sign-in…\nIf it does not open, visit:\n" + url)
    webbrowser.open(url)
    t.join()
    if "code" not in result:
        sys.exit("No authorisation code received.")

    r = httpx.post(
        TOKEN_URL,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "code": result["code"],
            "code_verifier": verifier,
            "grant_type": "authorization_code",
            "redirect_uri": redirect,
        },
    )
    r.raise_for_status()
    tokens = r.json()
    if "refresh_token" not in tokens:
        sys.exit("Google returned no refresh token; revoke Artha's access and retry.")

    # Create the backup folder (owned by this app, so drive.file can see it).
    folder = httpx.post(
        FILES_URL,
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
        json={"name": "Artha backups", "mimeType": "application/vnd.google-apps.folder"},
    )
    folder.raise_for_status()

    print("\nAdd these to the server .env:\n")
    print(f"ARTHA_GDRIVE_CLIENT_ID={client_id}")
    print(f"ARTHA_GDRIVE_CLIENT_SECRET={client_secret}")
    print(f"ARTHA_GDRIVE_REFRESH_TOKEN={tokens['refresh_token']}")
    print(f"ARTHA_GDRIVE_FOLDER_ID={folder.json()['id']}")


if __name__ == "__main__":
    main()
