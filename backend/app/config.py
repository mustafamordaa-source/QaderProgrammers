"""Application settings, loaded from the environment with dev-friendly defaults."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

# Signing keys that are public (in this repo) and must never sign real tokens.
KNOWN_WEAK_SECRETS = frozenset({"dev-secret-change-me", "change-me", "local-test", ""})
MIN_SECRET_LENGTH = 32


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # "production" turns on the start-up checks below. docker-compose.yml sets
    # it for the server container, so it does not depend on the .env file.
    app_env: str = "development"

    # Override in production. The default exists so `uvicorn app.main:app` works
    # straight after a fresh clone; production refuses to start with it.
    secret_key: str = "dev-secret-change-me"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 8

    database_url: str = "sqlite:///./taskflow.db"

    # Vite's default dev server origins.
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

    # --- agent hub ---------------------------------------------------------
    # Personal API tokens: the longest lifetime a person may pick.
    api_token_max_days: int = 90
    # Requests per minute. One uvicorn worker, so in-process buckets suffice.
    rate_login_per_minute: int = 5
    rate_token_reads_per_minute: int = 300
    rate_token_writes_per_minute: int = 60
    # Claim lease, in hours.
    claim_default_hours: float = 2
    claim_max_hours: float = 8
    # Comma-separated ID prefixes the text lint refuses (for example the
    # prefixes of a private tracker). Set on the server, never in this repo.
    lint_blocked_id_prefixes: str = ""
    # Comma-separated path fragments the lint refuses (private folders that
    # must never be named in the hub). Set on the server, never in this repo.
    lint_blocked_paths: str = ""

    # Attachments live on disk under this folder, named by content hash.
    files_dir: str = "./files"
    file_max_mb: int = 10
    # Total for all live attachments; protects a small server disk.
    files_total_mb: int = 200
    # Hosts a context link may point at (a host matches itself and its subdomains).
    context_url_hosts: str = "github.com,qader.com,qader.vip"

    # --- email notifications --------------------------------------------------
    # Gmail: smtp.gmail.com, port 587, STARTTLS, the account address as user
    # and an app password (needs 2-step verification on that account).
    # Email stays off until SMTP_HOST and SMTP_FROM are set.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    smtp_from_name: str = "Team hub"
    smtp_starttls: bool = True
    smtp_timeout_seconds: int = 20
    # Links in emails point here.
    hub_base_url: str = "http://127.0.0.1:5173"
    # Wait this long after a person's first unsent notification, then send
    # one email with everything pending for them.
    email_batch_seconds: int = 120
    email_poll_seconds: int = 30
    email_max_per_user_hour: int = 20
    # Gmail allows about 500 recipients a day on a normal account.
    email_max_per_day: int = 400
    email_max_attempts: int = 5
    # "auto": run the sender when SMTP is set; "off": never (tests, scripts).
    email_sender: str = "auto"

    # --- GitHub webhook -----------------------------------------------------
    # The webhook answers 404 until a secret is set. Use the same string in
    # GitHub > Settings > Webhooks > Secret.
    github_webhook_secret: str = ""
    # Repos whose events count, comma-separated owner/name.
    github_repos: str = ""
    # branch=state pairs for successful deploy workflow runs.
    github_deploy_rules: str = "develop=staging,main=production"
    # Task IDs in branch names and PR titles look like HUB-12.
    hub_id_prefix: str = "HUB"

    @property
    def email_enabled(self) -> bool:
        return bool(self.smtp_host and self.smtp_from)


def check_production_settings(s: "Settings") -> None:
    """Refuse to run in production with a public or short signing key."""
    if s.app_env.lower() != "production":
        return
    if s.secret_key in KNOWN_WEAK_SECRETS or len(s.secret_key) < MIN_SECRET_LENGTH:
        raise RuntimeError(
            "SECRET_KEY is a known default or shorter than "
            f"{MIN_SECRET_LENGTH} characters. Set a random one in the server env file: "
            'python3 -c "import secrets; print(secrets.token_urlsafe(48))"'
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
