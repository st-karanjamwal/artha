from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ARTHA_", env_file=".env", extra="ignore")

    data_dir: Path = Path("./data")
    # One-time token required to perform first-run setup (login password + TOTP enrolment).
    setup_token: str = ""
    session_ttl_hours: int = 12
    cookie_secure: bool = True
    # Trust X-Real-IP from our own reverse proxy for rate limiting.
    trust_proxy: bool = False
    enable_docs: bool = False

    max_vault_bytes: int = 64 * 1024 * 1024
    keep_versions: int = 30

    login_max_failures: int = 5
    login_window_minutes: int = 15
    login_global_max_failures: int = 20

    timezone: str = "Asia/Kolkata"

    # Google Drive backup (OAuth refresh token for the owner's account, scope drive.file).
    gdrive_client_id: str = ""
    gdrive_client_secret: str = ""
    gdrive_refresh_token: str = ""
    gdrive_folder_id: str = ""
    backup_time: str = "03:00"  # local time (timezone above), HH:MM
    backup_keep_daily: int = 30
    backup_keep_monthly: int = 12

    # Public mutual-fund data relays (no user data is sent).
    amfi_nav_url: str = "https://www.amfiindia.com/spages/NAVAll.txt"
    nav_history_provider: str = "mfapi"  # "mfapi" or "none"
    mfapi_base_url: str = "https://api.mfapi.in/mf"

    @property
    def gdrive_configured(self) -> bool:
        return bool(
            self.gdrive_client_id
            and self.gdrive_client_secret
            and self.gdrive_refresh_token
            and self.gdrive_folder_id
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
