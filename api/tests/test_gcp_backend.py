"""CloudBackend's GCP path against an in-memory fake of SecretManagerServiceClient."""
import datetime

import pytest

pytest.importorskip("google.cloud.secretmanager")
from google.api_core.exceptions import AlreadyExists, NotFound  # noqa: E402

from daas_api.identity import Conventions, StageSecrets  # noqa: E402
from daas_api.secrets_backend import CloudBackend  # noqa: E402

TS = StageSecrets("qa", "acme-secrets-qa", "1", "444444444444", "us-east-1")


class FakeSM:
    def __init__(self):
        self.secrets, self.versions = {}, {}

    def create_secret(self, request):
        name = f"{request['parent']}/secrets/{request['secret_id']}"
        if name in self.secrets:
            raise AlreadyExists("exists")
        self.secrets[name] = request["secret"]
        self.versions[name] = []

    def add_secret_version(self, request):
        self.versions[request["parent"]].append(request["payload"]["data"])

    def get_secret_version(self, request):
        name = request["name"].rsplit("/versions/", 1)[0]
        if not self.versions.get(name):
            raise NotFound("no versions")
        return object()

    def list_secrets(self, request):
        assert request["filter"].startswith("name:")
        return [type("S", (), {"name": n, "create_time": datetime.datetime(2026, 1, 1)})()
                for n in self.secrets if n.startswith(request["parent"])]

    def delete_secret(self, request):
        if request["name"] not in self.secrets:
            raise NotFound("gone")
        del self.secrets[request["name"]], self.versions[request["name"]]


def test_gcp_put_exists_list_delete():
    b = CloudBackend(Conventions())
    b._gcp = fake = FakeSM()
    key = "payments_app_DB_URL"
    assert not b.exists(TS, "gcp", key)
    b.put(TS, "gcp", key, "v1", {"team": "payments", "app": "app"})
    b.put(TS, "gcp", key, "v2", {"team": "payments", "app": "app"})  # second put adds a version
    assert fake.versions[f"projects/acme-secrets-qa/secrets/{key}"] == [b"v1", b"v2"]
    assert fake.secrets[f"projects/acme-secrets-qa/secrets/{key}"]["labels"]["managed-by"] == "daas"
    b.put(TS, "gcp", "web_site_X", "v", {})
    assert b.exists(TS, "gcp", key)
    assert [x["key"] for x in b.list(TS, "gcp", "payments_app_")] == [key]
    assert b.delete(TS, "gcp", key) and not b.delete(TS, "gcp", key)
