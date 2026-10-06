from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from daas_api.config import Settings
from daas_api.gitops import GitOpsRepo
from daas_api.main import create_app
from daas_api.policy import Platform
from daas_api.secrets_backend import MemoryBackend

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "examples" / "payments-api"


class FakeChecker:
    def __init__(self, unhealthy: set[str] = frozenset()):
        self.unhealthy = unhealthy
        self.calls: list[str] = []

    def wait(self, cluster, namespace, app, revision, timeout):
        self.calls.append(cluster)
        return (cluster not in self.unhealthy), "fake"


@pytest.fixture
def settings(tmp_path):
    return Settings(
        auth_mode="dev",
        platform_dir=ROOT / "platform",
        schema_file=ROOT / "spec" / "daas.schema.json",
        secrets_backend="memory",
        gitops_path=tmp_path / "gitops",
        reaper_interval_seconds=0,
    )


@pytest.fixture
def spec_text():
    return (EXAMPLE / "daas.yaml").read_text()


REGISTRY_AUTH = '{"auths": {"registry.gitlab.example.com": {"auth": "eDp5"}}}'
PLATFORM = Platform.load(ROOT / "platform")
STAGES = PLATFORM.stage_secrets
CONV = PLATFORM.conventions


@pytest.fixture
def secrets_backend():
    """Example app's secrets already set in every stage: DB_URL in GCP (team default), STRIPE_KEY in AWS."""
    b = MemoryBackend()
    for ts in STAGES.values():
        b.put(ts, "gcp", CONV.remote_key("payments", "payments-api", "DB_URL"), "x", {})
        b.put(ts, "aws", CONV.remote_key("payments", "payments-api", "STRIPE_KEY"), "x", {})
        for team in ("payments", "orders", "web"):  # registry pull credentials (platform registry is configured)
            b.put(ts, "gcp", CONV.remote_key(team, CONV.platformSecretsApp, "REGISTRY_AUTH"), REGISTRY_AUTH, {})
    return b


@pytest.fixture
def make_client(settings, secrets_backend):
    def _make(checker=None):
        repo = GitOpsRepo(settings.gitops_path)
        checker = checker or FakeChecker()
        app = create_app(settings, checker=checker, repo=repo, secrets=secrets_backend)
        return TestClient(app), repo, checker
    return _make
