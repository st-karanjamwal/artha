# Deploying Artha on AWS EC2 (alongside an existing app)

Artha runs as its own Docker Compose project (separate network and volume, non-root API user,
read-only API container). Only the web container is published, and only on `127.0.0.1:8080`.
The host nginx terminates TLS for `artha.<your-domain>` and proxies to it.

## 0. Before you start

- **Take an EBS snapshot** of the instance (it also hosts your ERP).
- DNS: create an `A` record `artha.<your-domain>` → the instance's Elastic IP.
- Security group: 80/443 open (already true if the ERP is served).
- Docker Engine + Compose plugin installed (`docker compose version`).

## 1. Get the code and configure

```bash
sudo mkdir -p /opt/artha && sudo chown $USER /opt/artha
git clone <your-repo-url> /opt/artha && cd /opt/artha
cp .env.example .env && chmod 600 .env
python3 -c "import secrets; print(secrets.token_urlsafe(32))"   # paste as ARTHA_SETUP_TOKEN
nano .env
```

Keep `ARTHA_COOKIE_SECURE=true`. If 8080 is taken by the ERP, change `ARTHA_WEB_PORT` (and the
port in `nginx/artha.conf`).

## 2. Build and start

```bash
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:8080/api/health    # {"status":"ok"}
```

## 3. Host nginx + TLS

```bash
sudo cp nginx/artha.conf /etc/nginx/sites-available/artha.conf
sudo sed -i 's/artha.example.com/artha.<your-domain>/g' /etc/nginx/sites-available/artha.conf
sudo ln -s /etc/nginx/sites-available/artha.conf /etc/nginx/sites-enabled/
```

First certificate: comment out the whole `listen 443` server block, then run
`sudo nginx -t && sudo systemctl reload nginx`, then
`sudo certbot certonly --webroot -w /var/www/html -d artha.<your-domain>`. Uncomment the block
and run `sudo nginx -t && sudo systemctl reload nginx` again. (Or use `sudo certbot --nginx -d
artha.<your-domain>` if you prefer certbot to edit the file.)

Open `https://artha.<your-domain>` and complete **server setup** with the token, then create the
vault ([README](../README.md#first-run-walkthrough)).

After setup you may blank `ARTHA_SETUP_TOKEN` in `.env` and run `docker compose up -d`. Setup
cannot be repeated anyway while `auth.json` exists.

## 4. Google Drive backup

Use a Google account you control. Keep the **recovery key out of this Drive**.

1. https://console.cloud.google.com → new project "Artha" → **APIs & Services → Library** →
   enable **Google Drive API**.
2. **OAuth consent screen** → External → add yourself as a test user. Scope `drive.file` is
   enough; Artha can only see files it creates.
3. **Credentials → Create credentials → OAuth client ID → Desktop app**. Note the ID and secret.
4. On your **laptop** (it opens a browser):
   ```bash
   cd backend && .venv/bin/python scripts/gdrive_auth.py <CLIENT_ID> <CLIENT_SECRET>
   ```
   It creates a folder "Artha backups" and prints four `ARTHA_GDRIVE_*` lines.
5. Put them in the server's `.env`, then run `docker compose up -d`.
6. In the app: Settings → Backup & restore → **Back up now**. Check that the file appears in Drive.

Backups run daily at `ARTHA_BACKUP_TIME` (default 03:00 IST). They're skipped if nothing changed
and kept as 30 daily + 12 monthly.

> While the OAuth app is in "Testing" status, Google expires refresh tokens after 7 days. To avoid
> that, set the consent screen to **In production** (no verification is needed for personal use
> with the `drive.file` scope), then re-run step 4.

## 5. Updating

```bash
cd /opt/artha && git pull && docker compose up -d --build
```

Schema migrations run in the browser on the next unlock and the vault is re-saved automatically.

## 6. Operations

| Task | Command |
|---|---|
| Logs | `docker compose logs -f api` |
| Data location | Docker volume `artha_artha_data` (`docker volume inspect artha_artha_data`) |
| Manual copy of all versions | `docker compose cp api:/data ./artha-data-backup` |
| Reset login/TOTP | see [RESTORE.md](RESTORE.md) §6 |

The volume lives on the instance's EBS disk, so your EBS snapshot schedule covers it too.
