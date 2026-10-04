from datetime import datetime
from zoneinfo import ZoneInfo

from app.backup_gdrive import backup_name, run_backup, seconds_until_next, select_for_deletion
from app.vault import VaultStore


def test_retention_keeps_daily_and_monthly():
    names = []
    # Two backups per day for 90 days ending 2026-03-31.
    from datetime import date, timedelta

    d = date(2026, 3, 31)
    for i in range(90):
        day = d - timedelta(days=i)
        names += [f"artha_{day:%Y-%m-%d}_0300.vault", f"artha_{day:%Y-%m-%d}_1500.vault"]
    names.append("unrelated.txt")
    delete = set(select_for_deletion(names, keep_daily=30, keep_monthly=12))
    kept = sorted(set(names) - delete)
    assert "unrelated.txt" in kept
    # Newest of each of the last 30 days is kept; older backup of same day deleted.
    assert "artha_2026-03-31_1500.vault" in kept
    assert "artha_2026-03-31_0300.vault" in delete
    daily = [n for n in kept if n.endswith("_1500.vault") and n >= "artha_2026-03-02"]
    assert len(daily) == 30
    # Newest of Feb and Jan (month-end) kept as monthly.
    assert "artha_2026-02-28_1500.vault" in kept
    assert "artha_2026-01-31_1500.vault" in kept
    assert "artha_2026-01-30_1500.vault" in delete


def test_backup_name():
    assert backup_name(datetime(2026, 1, 5, 3, 7)) == "artha_2026-01-05_0307.vault"


def test_seconds_until_next(settings):
    tz = ZoneInfo(settings.timezone)
    settings.backup_time = "03:00"
    assert seconds_until_next(settings, datetime(2026, 1, 1, 2, 0, tzinfo=tz)) == 3600
    assert seconds_until_next(settings, datetime(2026, 1, 1, 4, 0, tzinfo=tz)) == 23 * 3600


class FakeDrive:
    def __init__(self):
        self.files = {}

    def _token(self):
        return "t"

    def upload(self, token, name, data):
        self.files[name] = data
        return name

    def list_backups(self, token):
        return [{"id": n, "name": n} for n in self.files]

    def delete(self, token, file_id):
        self.files.pop(file_id)


def test_run_backup_uploads_and_skips_unchanged(settings):
    settings.gdrive_client_id = settings.gdrive_client_secret = "x"
    settings.gdrive_refresh_token = settings.gdrive_folder_id = "x"
    VaultStore(settings).write_new(b"ARTHA1 encrypted")
    drive = FakeDrive()
    state = run_backup(settings, client=drive)
    assert state["last_error"] is None
    assert list(drive.files.values()) == [b"ARTHA1 encrypted"]
    state = run_backup(settings, client=drive)
    assert state["last_result"].startswith("skipped")
