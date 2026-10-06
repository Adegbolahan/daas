"""Read API for UIs (Backstage): schemas, platform, apps, deployments, spec, preview."""
import shutil

import pytest

from daas_api.policy import Platform
from tests.conftest import ROOT

USER = {"X-DAAS-User": "ada@acme.com"}
CI = {"X-DAAS-Project": "acme/payments/payments-api", "X-DAAS-Environment": "production"}


def test_schemas(make_client):
    client, _, _ = make_client()
    j = client.get("/v1/schemas", headers=USER).json()
    assert set(j) == {"app", "teamAccess", "teamClusters", "teamSecrets"}
    assert "stages" in j["app"]["properties"] and j["teamClusters"]["type"] == "array"


def test_platform_view(make_client):
    client, _, _ = make_client()
    j = client.get("/v1/platform", headers=USER).json()
    assert [s["name"] for s in j["stages"]] == ["preview", "qa", "uat", "perf", "staging", "production"]
    pay = next(t for t in j["teams"] if t["name"] == "payments")
    assert {c["name"] for c in pay["clusters"]} >= {"payments-gke-usc1-prod", "payments-eks-use1-uat"}
    assert pay["secretsProvider"] == "gcp" and j["configError"] is None


def test_apps_deployments_and_spec(make_client, spec_text):
    client, _, _ = make_client()
    rid = client.post("/v1/deployments", headers=CI,
                      json={"spec": spec_text, "image": "reg/p:1", "environment": "production"}).json()["id"]
    apps = client.get("/v1/apps", params={"team": "payments"}, headers=USER).json()["apps"]
    a = next(x for x in apps if x["app"] == "payments-api")
    prod = a["environments"][0]
    assert prod["stage"] == "production" and prod["image"] == "reg/p:1"
    assert {c["cluster"] for c in prod["clusters"]} == {"payments-gke-usc1-prod", "payments-eks-use1-prod",
                                                        "payments-gke-euw1-prod"}
    assert any("pay.example.com" in c["hosts"] for c in prod["clusters"])
    deps = client.get("/v1/deployments", params={"app": "payments-api"}, headers=USER).json()["deployments"]
    assert deps[0]["id"] == rid and "spec" not in deps[0] and deps[0]["team"] == "payments"
    spec = client.get("/v1/apps/payments/payments-api/spec", headers=USER).json()
    assert spec["spec"] == spec_text and spec["project"] == "acme/payments/payments-api"
    assert client.get("/v1/apps/payments/nope/spec", headers=USER).status_code == 404


def test_preview_valid_with_skips_and_warnings(make_client, spec_text):
    client, repo, _ = make_client()
    before = repo._git("rev-parse", "HEAD")
    j = client.post("/v1/preview", headers=USER,
                    json={"spec": spec_text, "team": "payments", "environment": "qa-3"}).json()
    assert j["valid"] and j["stage"] == "qa"
    assert [p["cluster"] for p in j["plan"]] == ["payments-gke-usc1-qa"]
    assert sorted(j["skippedTargets"]) == ["eks/us-east-1", "gke/europe-west1"]
    assert j["warnings"] and "kind: Deployment" in j["manifests"]["payments-gke-usc1-qa"]
    assert repo._git("rev-parse", "HEAD") == before  # preview never commits


@pytest.mark.parametrize("body,msg", [
    ({"spec": "apiVersion: nope\n", "team": "payments", "environment": "qa"}, "apiVersion"),
    ({"team": "payments", "environment": "sandbox"}, "doesn't map to any stage"),
    ({"team": "orders", "environment": "uat"}, "may not deploy to stage 'uat'"),
    ({"team": "nope", "environment": "qa"}, "unknown team"),
])
def test_preview_errors(make_client, spec_text, body, msg):
    client, _, _ = make_client()
    j = client.post("/v1/preview", headers=USER, json={"spec": spec_text, **body}).json()
    assert not j["valid"] and any(msg in e for e in j["errors"]), j["errors"]


def test_preview_reports_missing_secrets(make_client, spec_text):
    client, _, _ = make_client()
    spec = spec_text.replace("name: payments-api", "name: ledger")
    j = client.post("/v1/preview", headers=USER, json={"spec": spec, "team": "payments", "environment": "staging"}).json()
    assert j["valid"] and {m["name"] for m in j["missingSecrets"]} == {"DB_URL", "STRIPE_KEY"}


def test_team_files_validated_against_schemas(tmp_path):
    root = tmp_path / "platform"
    shutil.copytree(ROOT / "platform", root)
    f = root / "teams/web/access.yaml"
    f.write_text(f.read_text() + "unknownKey: 1\n")
    with pytest.raises(ValueError, match="teams/web/access.yaml.*unknownKey"):
        Platform.load(root, ROOT / "spec")
