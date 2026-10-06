"""CloudBackend's AWS path against moto (no real AWS)."""
import pytest

moto = pytest.importorskip("moto")

from daas_api.identity import Conventions, StageSecrets  # noqa: E402
from daas_api.secrets_backend import CloudBackend  # noqa: E402

TS = StageSecrets("staging", "p", "1", "123456789012", "us-east-1")


@pytest.fixture(autouse=True)
def aws_env(monkeypatch):
    for k, v in {"AWS_ACCESS_KEY_ID": "x", "AWS_SECRET_ACCESS_KEY": "x", "AWS_DEFAULT_REGION": "us-east-1"}.items():
        monkeypatch.setenv(k, v)


@moto.mock_aws
def test_aws_put_exists_list_delete():
    b = CloudBackend(Conventions())
    key = "payments_app_DB_URL"
    assert not b.exists(TS, "aws", key)
    b.put(TS, "aws", key, "v1", {"team": "payments", "app": "app"})
    b.put(TS, "aws", key, "v2", {"team": "payments", "app": "app"})  # update path
    b.put(TS, "aws", "web_site_X", "v", {"team": "web", "app": "site"})
    assert b.exists(TS, "aws", key)
    assert [x["key"] for x in b.list(TS, "aws", "payments_app_")] == [key]
    assert b.delete(TS, "aws", key)
    assert not b.exists(TS, "aws", key)          # pending deletion counts as gone
    assert not b.delete(TS, "aws", key)
    assert not b.delete(TS, "aws", "nope")
    b.put(TS, "aws", key, "v3", {"team": "payments", "app": "app"})  # re-set inside the recovery window
    assert b.exists(TS, "aws", key)
