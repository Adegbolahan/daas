"""Team folders: generated files are current, and the orders sample app goes end to end."""
from fastapi.testclient import TestClient

from daas_api.gitops import GitOpsRepo
from daas_api.main import create_app
from daas_api.policy import Platform
from daas_api.secrets_backend import MemoryBackend
from daas_api.team import generated_files
from tests.conftest import REGISTRY_AUTH, FakeChecker, ROOT

ORDERS_API = ROOT / "examples" / "orders-api"


def test_generated_team_files_are_current():
    """teams/<team>/README.md and CODEOWNERS must be regenerated when the platform folder changes."""
    platform_dir = ROOT / "platform"
    stale = [str(p) for p, content in generated_files(Platform.load(platform_dir), platform_dir).items()
             if not p.exists() or p.read_text() != content]
    assert not stale, f"run `cd api && python -m daas_api.team --write`: {stale}"


def test_orders_api_end_to_end(settings):
    client = TestClient(create_app(settings, checker=FakeChecker(), repo=GitOpsRepo(settings.gitops_path),
                                   secrets=MemoryBackend()))
    spec = (ORDERS_API / "daas.yaml").read_text()
    writer = {"X-DAAS-Roles": "orders.secrets,orders.secrets.prod"}

    def deploy(env):
        h = {"X-DAAS-Project": "acme/orders/orders-api", "X-DAAS-Environment": env}  # tier from the stage (dev mode)
        return client.post("/v1/deployments", headers=h, json={"spec": spec, "image": "reg/orders:1", "environment": env})

    r = deploy("review/mr-1")
    assert r.status_code == 422 and "DATABASE_URL (aws)" in r.text and "PAYMENTS_API_KEY (gcp)" in r.text
    assert "REGISTRY_AUTH (registry) (gcp)" in r.text

    for stage in ("preview", "qa", "staging", "production"):
        assert client.put(f"/v1/secrets/{stage}/orders/daas/REGISTRY_AUTH", json={"value": REGISTRY_AUTH},
                          headers=writer).status_code == 200
        client.put(f"/v1/secrets/{stage}/orders/orders-api/DATABASE_URL", json={"value": "x"}, headers=writer)
        client.put(f"/v1/secrets/{stage}/orders/orders-api/PAYMENTS_API_KEY", json={"value": "x", "provider": "gcp"},
                   headers=writer)

    r = deploy("review/mr-1")
    assert r.status_code == 202 and r.json()["url"] == "https://orders-api-mr-1.orders.preview.example.com"
    r = deploy("qa")  # qa only has a GKE cluster: the EKS target is skipped, not an error
    assert r.status_code == 202, r.text
    assert [p["cluster"] for p in r.json()["plan"]] == ["orders-gke-usc1-qa"]
    assert r.json()["skippedTargets"] == ["eks/us-east-1"]
    r = deploy("staging")
    assert [p["cluster"] for p in r.json()["plan"]] == ["orders-eks-use1-stage", "orders-gke-usc1-stage"]
    r = deploy("production")
    assert [p["cluster"] for p in r.json()["plan"]] == ["orders-eks-use1-prod", "orders-gke-usc1-prod"]
    assert client.post("/v1/deployments", json={"spec": spec, "image": "i", "environment": "uat"},
                       headers={"X-DAAS-Project": "acme/orders/orders-api", "X-DAAS-Environment": "uat"}
                       ).status_code == 403  # orders isn't enabled for uat
