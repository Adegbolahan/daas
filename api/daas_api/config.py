import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str) -> str:
    return os.getenv(name, default)


@dataclass(frozen=True)
class Settings:
    # Auth
    auth_mode: str = field(default_factory=lambda: _env("DAAS_AUTH_MODE", "gitlab"))  # gitlab | dev
    gitlab_url: str = field(default_factory=lambda: _env("DAAS_GITLAB_URL", "https://gitlab.com"))
    audience: str = field(default_factory=lambda: _env("DAAS_AUDIENCE", "https://daas.example.com"))
    # Platform config
    # The platform repo folder: stages.yaml, conventions.yaml, service.yaml, teams/<team>/...
    platform_dir: Path = field(default_factory=lambda: Path(_env("DAAS_PLATFORM_DIR", "../platform")))
    platform_reload_seconds: int = field(default_factory=lambda: int(_env("DAAS_PLATFORM_RELOAD_SECONDS", "30")))  # 0 = off
    schema_file: Path = field(default_factory=lambda: Path(_env("DAAS_SCHEMA_FILE", "../spec/daas.schema.json")))
    # GitOps
    gitops_path: Path = field(default_factory=lambda: Path(_env("DAAS_GITOPS_PATH", "/tmp/daas-gitops")))
    gitops_push: bool = field(default_factory=lambda: _env("DAAS_GITOPS_PUSH", "false") == "true")
    gitops_token: str = field(default_factory=lambda: _env("DAAS_GITOPS_TOKEN", ""))  # GitLab token, write_repository
    sync_platform_on_start: bool = field(default_factory=lambda: _env("DAAS_SYNC_PLATFORM", "true") == "true")
    # Health (empty ARGOCD_URL = don't wait for health, status 'committed')
    argocd_url: str = field(default_factory=lambda: _env("DAAS_ARGOCD_URL", ""))
    argocd_token: str = field(default_factory=lambda: _env("DAAS_ARGOCD_TOKEN", ""))
    wave_timeout_seconds: int = field(default_factory=lambda: int(_env("DAAS_WAVE_TIMEOUT", "600")))
    # Without Argo CD, a committed wave counts as done. Only allowed in dev mode unless explicitly accepted.
    allow_unverified_health: bool = field(default_factory=lambda: _env("DAAS_ALLOW_UNVERIFIED_HEALTH", "false") == "true")
    # Deployment records (SQLite file on a volume; empty = in memory)
    state_db: str = field(default_factory=lambda: _env("DAAS_STATE_DB", ""))
    # Secrets
    secrets_backend: str = field(default_factory=lambda: _env("DAAS_SECRETS_BACKEND", "cloud"))  # cloud | memory
    check_secrets: bool = field(default_factory=lambda: _env("DAAS_CHECK_SECRETS", "true") == "true")
    # Entra ID (Azure AD) for humans calling the secrets API
    entra_tenant_id: str = field(default_factory=lambda: _env("DAAS_ENTRA_TENANT_ID", ""))
    entra_audience: str = field(default_factory=lambda: _env("DAAS_ENTRA_AUDIENCE", ""))  # DAAS app client ID or api://...
    # Previews
    preview_ttl_hours: int = field(default_factory=lambda: int(_env("DAAS_PREVIEW_TTL_HOURS", "72")))
    reaper_interval_seconds: int = field(default_factory=lambda: int(_env("DAAS_REAPER_INTERVAL", "900")))  # 0 = off
