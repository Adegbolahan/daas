from datetime import datetime, timedelta, timezone

import yaml

from daas_api import reaper
from tests.conftest import FakeChecker

PROJECT = "acme/payments/payments-api"


def hdr(env="production", project=PROJECT, protected="true", tier=None):
    h = {"X-DAAS-Project": project, "X-DAAS-Environment": env, "X-DAAS-Environment-Protected": protected}
    if tier:
        h["X-DAAS-Tier"] = tier
    return h


def body(spec, env="production", **kw):
    return {"spec": spec, "image": "reg/payments:1", "environment": env, **kw}


# ---------- core flow ----------

def test_dry_run_returns_manifests_and_commits_no_app(make_client, spec_text):
    client, repo, _ = make_client()
    r = client.post("/v1/deployments", json=body(spec_text, dryRun=True), headers=hdr())
    assert r.status_code == 202, r.text
    plan = r.json()["plan"]
    assert [p["cluster"] for p in plan] == ["payments-gke-usc1-prod", "payments-eks-use1-prod", "payments-gke-euw1-prod"]
    assert [p["wave"] for p in plan] == [1, 2, 3]
    assert "kind: Deployment" in plan[0]["manifests"]
    assert not (repo.path / "clusters").exists()


def test_sequential_rollout_writes_gitops_and_succeeds(make_client, spec_text):
    client, repo, checker = make_client()
    rid = client.post("/v1/deployments", json=body(spec_text), headers=hdr()).json()["id"]
    st = client.get(f"/v1/deployments/{rid}", headers=hdr()).json()
    assert st["status"] == "succeeded", st
    assert checker.calls == ["payments-gke-usc1-prod", "payments-eks-use1-prod", "payments-gke-euw1-prod"]
    d = "clusters/payments-eks-use1-prod/payments/payments-api"
    assert (repo.path / d / "manifests.yaml").exists()
    assert repo.read_meta(d)["project"] == PROJECT and repo.read_meta(d)["team"] == "payments"


def test_unhealthy_canary_stops_rollout(make_client, spec_text):
    client, repo, _ = make_client(FakeChecker(unhealthy={"payments-gke-usc1-prod"}))
    rid = client.post("/v1/deployments", json=body(spec_text), headers=hdr()).json()["id"]
    assert client.get(f"/v1/deployments/{rid}", headers=hdr()).json()["status"] == "failed"
    assert not (repo.path / "clusters/payments-eks-use1-prod").exists()


def test_invalid_spec_is_422(make_client):
    client, _, _ = make_client()
    r = client.post("/v1/deployments", json=body("apiVersion: nope\n"), headers=hdr())
    assert r.status_code == 422 and r.json()["detail"]["errors"]


def test_region_without_cluster_is_explained(make_client, spec_text):
    client, _, _ = make_client()
    d = spec_text.split("targets:")[0] + "targets: [{provider: eks, region: ap-south1}]\n"
    r = client.post("/v1/deployments", json=body(d), headers=hdr())
    assert r.status_code == 403 and "available:" in r.text


# ---------- permissions ----------

def test_unknown_project_forbidden(make_client, spec_text):
    client, _, _ = make_client()
    r = client.post("/v1/deployments", json=body(spec_text), headers=hdr(project="acme/other/x"))
    assert r.status_code == 403


def test_team_not_allowed_in_env(make_client, spec_text):
    client, _, _ = make_client()
    r = client.post("/v1/deployments", json=body(spec_text), headers=hdr(project="acme/storefront"))
    assert r.status_code == 403 and "may not deploy" in r.text


def test_token_environment_must_match_request(make_client, spec_text):
    client, _, _ = make_client()
    r = client.post("/v1/deployments", json=body(spec_text, "production"), headers=hdr(env="staging"))
    assert r.status_code == 403 and "token was issued for environment 'staging'" in r.text


def test_job_must_declare_the_stages_gitlab_tier(make_client, spec_text):
    client, _, _ = make_client()
    r = client.post("/v1/deployments", json=body(spec_text), headers=hdr(tier="staging"))
    assert r.status_code == 403 and "must declare deployment_tier 'production'" in r.text


def test_unmapped_environment_rejected(make_client, spec_text):
    client, _, _ = make_client()
    r = client.post("/v1/deployments", json=body(spec_text, "sandbox"), headers=hdr("sandbox", tier="other"))
    assert r.status_code == 403 and "doesn't map to any stage" in r.text and "qa-* -> qa" in r.text


def _single_region(spec_text, provider, region):
    return spec_text.split("targets:")[0] + f"targets: [{{provider: {provider}, region: {region}}}]\n"


def test_more_stages_than_gitlab_tiers(make_client, spec_text):
    """qa, uat and perf all use GitLab's `testing` tier but are separate stages with their own clusters."""
    client, repo, _ = make_client()
    for env, spec, cluster in (("qa-7", _single_region(spec_text, "gke", "us-central1"), "payments-gke-usc1-qa"),
                               ("uat", _single_region(spec_text, "eks", "us-east-1"), "payments-eks-use1-uat"),
                               ("perf", _single_region(spec_text, "gke", "us-central1"), "payments-gke-usc1-perf")):
        r = client.post("/v1/deployments", json=body(spec, env), headers=hdr(env, tier="testing"))
        assert r.status_code == 202, r.text
        assert [p["cluster"] for p in r.json()["plan"]] == [cluster]
        meta = repo.read_meta(f"clusters/{cluster}/payments/payments-api")
        assert meta["stage"] == env.split("-")[0] and meta["tier"] == "testing"


def test_team_only_deploys_to_its_own_clusters(make_client, spec_text):
    """orders has no europe-west1 production cluster; payments' cluster there is not available to it."""
    client, _, _ = make_client()
    spec = spec_text.replace("name: payments-api", "name: orders-api")
    r = client.post("/v1/deployments", json=body(spec), headers=hdr(project="acme/orders/orders-api"))
    assert r.status_code == 403 and "team 'orders' has no 'production' cluster for gke/europe-west1" in r.text


def test_team_without_stage_rejected(make_client, spec_text):
    client, _, _ = make_client()
    r = client.post("/v1/deployments", json=body(spec_text, "uat"),
                    headers=hdr("uat", tier="testing", project="acme/orders/orders-api"))
    assert r.status_code == 403 and "may not deploy to stage 'uat'" in r.text


def test_rules_follow_stage_not_name(make_client, spec_text):
    """production-eu routes to the production stage: same gates, production clusters."""
    client, _, _ = make_client()
    eu = spec_text.split("targets:")[0] + "targets: [{provider: eks, region: eu-west-1}]\n"
    env = "production-eu"
    r = client.post("/v1/deployments", json=body(eu, env), headers=hdr(env, tier="production", protected="false"))
    assert r.status_code == 403 and "protected environment" in r.text
    r = client.post("/v1/deployments", json=body(eu, env), headers=hdr(env, tier="production"))
    assert r.status_code == 202 and [p["cluster"] for p in r.json()["plan"]] == ["payments-eks-euw1-prod"]


def test_two_environments_cannot_share_a_cluster_slot(make_client, spec_text):
    client, _, _ = make_client()
    assert client.post("/v1/deployments", json=body(spec_text), headers=hdr()).status_code == 202
    env = "production-us"  # same targets as production
    r = client.post("/v1/deployments", json=body(spec_text, env), headers=hdr(env, tier="production"))
    assert r.status_code == 409 and "already deployed by environment 'production'" in r.text


def test_production_requires_protected_environment(make_client, spec_text):
    client, _, _ = make_client()
    r = client.post("/v1/deployments", json=body(spec_text), headers=hdr(protected="false"))
    assert r.status_code == 403 and "protected environment" in r.text


def test_app_name_owned_by_first_project(make_client, spec_text):
    client, _, _ = make_client()
    assert client.post("/v1/deployments", json=body(spec_text), headers=hdr()).status_code == 202
    r = client.post("/v1/deployments", json=body(spec_text), headers=hdr(project="acme/payments/other"))
    assert r.status_code == 409 and "owned by project" in r.text


def test_other_project_cannot_read_status(make_client, spec_text):
    client, _, _ = make_client()
    rid = client.post("/v1/deployments", json=body(spec_text, dryRun=True), headers=hdr()).json()["id"]
    assert client.get(f"/v1/deployments/{rid}", headers=hdr(project="acme/web/site")).status_code == 404


def test_platform_objects_rendered_on_start(make_client):
    _, repo, _ = make_client()
    projects = {p["metadata"]["name"]: p for p in
                yaml.safe_load_all((repo.path / "platform/argocd/appprojects.yaml").read_text())}
    pay = projects["payments"]["spec"]
    assert {"name": "payments-gke-usc1-preview", "namespace": "payments-preview"} in pay["destinations"]
    assert {"name": "payments-eks-use1-prod", "namespace": "payments"} in pay["destinations"]
    assert pay["clusterResourceWhitelist"] == []
    assert projects["web"]["spec"]["destinations"] == [{"name": "web-eks-use1-stage", "namespace": "web"}]
    # dedicated clusters: no team can target another team's cluster
    assert not any(d["name"].startswith("orders-") for d in pay["destinations"])
    preview = list(yaml.safe_load_all((repo.path / "platform/payments-gke-usc1-preview/namespaces.yaml").read_text()))
    assert {d["kind"] for d in preview} == {"Namespace", "RoleBinding", "ResourceQuota", "ServiceAccount", "SecretStore",
                                            "LimitRange", "NetworkPolicy", "ExternalSecret"}
    assert {"group": "external-secrets.io", "kind": "SecretStore"} in pay["namespaceResourceBlacklist"]


def test_argocd_objects_rendered_from_platform_folder(make_client):
    _, repo, _ = make_client()
    sets = {d["metadata"]["name"]: d for d in
            yaml.safe_load_all((repo.path / "platform/argocd/applicationsets.yaml").read_text())}
    assert set(sets) == {"daas-platform", "daas-apps"}
    apps = sets["daas-apps"]["spec"]
    assert apps["generators"][0]["git"]["repoURL"] == "https://gitlab.example.com/platform/daas-gitops.git"
    assert apps["template"]["spec"]["project"] == "{{ .team }}"
    from daas_api.platform_render import bootstrap
    assert bootstrap("r")["spec"]["source"]["path"] == "platform/argocd"


def _platform_docs(repo, cluster):
    return list(yaml.safe_load_all((repo.path / f"platform/{cluster}/namespaces.yaml").read_text()))


def test_gke_namespace_reaches_both_clouds(make_client):
    _, repo, _ = make_client()
    docs = [d for d in _platform_docs(repo, "payments-gke-usc1-prod") if d["metadata"].get("namespace") == "payments"]
    sa = next(d for d in docs if d["kind"] == "ServiceAccount")
    assert sa["metadata"]["annotations"] == {
        "eks.amazonaws.com/role-arn": "arn:aws:iam::111111111111:role/daas-secrets-payments",
        "iam.gke.io/gcp-service-account": "daas-sec-payments@acme-secrets-prod.iam.gserviceaccount.com"}
    stores = {d["metadata"]["name"]: d["spec"]["provider"] for d in docs if d["kind"] == "SecretStore"}
    assert stores["daas-gcp"]["gcpsm"]["projectID"] == "acme-secrets-prod"
    assert stores["daas-gcp"]["gcpsm"]["auth"]["workloadIdentity"]["clusterProjectID"] == "acme-payments-prod"
    assert stores["daas-aws"]["aws"]["auth"] == {"jwt": {"serviceAccountRef": {"name": "daas-secrets", "audiences": ["sts.amazonaws.com"]}}}


def test_eks_namespace_uses_wif_for_gcp(make_client):
    _, repo, _ = make_client()
    docs = [d for d in _platform_docs(repo, "payments-eks-use1-prod") if d["kind"] == "SecretStore"]
    wif = next(d for d in docs if d["metadata"]["name"] == "daas-gcp")["spec"]["provider"]["gcpsm"]["auth"]
    assert wif["workloadIdentityFederation"]["audience"] == (
        "//iam.googleapis.com/projects/100000000001/locations/global/workloadIdentityPools/daas-k8s/providers/payments-eks-use1-prod")
    assert wif["workloadIdentityFederation"]["gcpServiceAccountEmail"] == \
        "daas-sec-payments@acme-secrets-prod.iam.gserviceaccount.com"


def test_preview_namespace_uses_preview_stage_secrets(make_client):
    _, repo, _ = make_client()
    stores = {d["metadata"]["name"]: d for d in _platform_docs(repo, "payments-gke-usc1-preview") if d["kind"] == "SecretStore"}
    assert stores["daas-gcp"]["spec"]["provider"]["gcpsm"]["projectID"] == "acme-secrets-preview"
    assert stores["daas-gcp"]["metadata"]["namespace"] == "payments-preview"


# ---------- previews ----------

def test_preview_deploy(make_client, spec_text):
    client, repo, checker = make_client()
    env = "review/mr-42"
    r = client.post("/v1/deployments", json=body(spec_text, env), headers=hdr(env))
    assert r.status_code == 202, r.text
    j = r.json()
    assert j["url"] == "https://payments-api-mr-42.payments.preview.example.com"
    assert [p["cluster"] for p in j["plan"]] == ["payments-gke-usc1-preview"]  # targets ignored
    d = "clusters/payments-gke-usc1-preview/payments-preview/payments-api-mr-42"
    meta = repo.read_meta(d)
    assert meta["preview"] is True and meta["expiresAt"]
    assert "kind: HTTPRoute" in (repo.path / d / "manifests.yaml").read_text()


def test_preview_not_enabled_for_team(make_client, spec_text):
    client, _, _ = make_client()
    env = "review/mr-1"
    r = client.post("/v1/deployments", json=body(spec_text, env), headers=hdr(env, project="acme/storefront"))
    assert r.status_code == 403


def test_preview_cap(make_client, spec_text):
    client, _, _ = make_client()
    for i in range(5):
        env = f"review/mr-{i}"
        assert client.post("/v1/deployments", json=body(spec_text, env), headers=hdr(env)).status_code == 202
    env = "review/mr-99"
    r = client.post("/v1/deployments", json=body(spec_text, env), headers=hdr(env))
    assert r.status_code == 403 and "max 5" in r.text
    # redeploying an existing preview is still allowed
    env = "review/mr-0"
    assert client.post("/v1/deployments", json=body(spec_text, env), headers=hdr(env)).status_code == 202


def test_preview_slug_from_route_pattern(make_client, spec_text):
    client, _, _ = make_client()
    env = "review/Feature X!"
    r = client.post("/v1/deployments", json=body(spec_text, env), headers=hdr(env))
    assert r.status_code == 202
    assert r.json()["url"] == "https://payments-api-feature-x.payments.preview.example.com"


def test_stop_removes_preview(make_client, spec_text):
    client, repo, _ = make_client()
    env = "review/mr-7"
    client.post("/v1/deployments", json=body(spec_text, env), headers=hdr(env))
    d = "clusters/payments-gke-usc1-preview/payments-preview/payments-api-mr-7"
    assert repo.read_meta(d)
    # another project in the same team can't remove it
    assert client.delete(f"/v1/environments/{env}", headers=hdr(env, project="acme/payments/other")).status_code == 404
    r = client.delete(f"/v1/environments/{env}", headers=hdr(env))
    assert r.status_code == 200 and r.json()["removed"] == [d]
    assert not (repo.path / d).exists()
    assert client.delete(f"/v1/environments/{env}", headers=hdr(env)).status_code == 404


def test_delete_requires_matching_token_env(make_client, spec_text):
    client, _, _ = make_client()
    env = "review/mr-8"
    client.post("/v1/deployments", json=body(spec_text, env), headers=hdr(env))
    assert client.delete(f"/v1/environments/{env}", headers=hdr("review/mr-9")).status_code == 403


def test_reaper_removes_only_expired_previews(make_client, spec_text):
    client, repo, _ = make_client()
    env = "review/mr-3"
    client.post("/v1/deployments", json=body(spec_text, env), headers=hdr(env))
    client.post("/v1/deployments", json=body(spec_text), headers=hdr())  # production app
    assert reaper.reap(repo) == []  # nothing expired yet
    removed = reaper.reap(repo, now=datetime.now(timezone.utc) + timedelta(days=4))
    assert removed == ["clusters/payments-gke-usc1-preview/payments-preview/payments-api-mr-3"]
    assert repo.read_meta("clusters/payments-gke-usc1-prod/payments/payments-api")  # prod untouched


# ---------- secrets ----------

WRITER = {"X-DAAS-User": "ada@acme.com", "X-DAAS-Roles": "payments.secrets"}
PROD_WRITER = {"X-DAAS-User": "lead@acme.com", "X-DAAS-Roles": "payments.secrets.prod"}


def test_deploy_blocked_when_secret_missing(make_client, spec_text, secrets_backend):
    client, _, _ = make_client()
    from tests.conftest import STAGES
    secrets_backend.delete(STAGES["production"], "aws", "payments_payments-api_STRIPE_KEY")
    r = client.post("/v1/deployments", json=body(spec_text), headers=hdr())
    assert r.status_code == 422 and "STRIPE_KEY (aws)" in r.text and "PUT /v1/secrets/production/payments/<app>/<NAME>" in r.text


def test_secret_write_requires_entra_role(make_client):
    client, _, _ = make_client()
    url = "/v1/secrets/staging/payments/new-app/API_KEY"
    assert client.put(url, json={"value": "s3cr3t"}, headers={"X-DAAS-Roles": "web.secrets"}).status_code == 403
    r = client.put(url, json={"value": "s3cr3t"}, headers=WRITER)
    assert r.status_code == 200 and r.json() == {"key": "payments_new-app_API_KEY", "provider": "gcp", "stage": "staging"}


def test_production_secrets_need_prod_role(make_client):
    client, _, _ = make_client()
    url = "/v1/secrets/production/payments/new-app/API_KEY"
    assert client.put(url, json={"value": "x"}, headers=WRITER).status_code == 403
    assert client.put(url, json={"value": "x"}, headers=PROD_WRITER).status_code == 200


def test_list_shows_metadata_never_values(make_client):
    client, _, _ = make_client()
    client.put("/v1/secrets/staging/payments/new-app/A", json={"value": "v1"}, headers=WRITER)
    client.put("/v1/secrets/staging/payments/new-app/B", json={"value": "v2", "provider": "aws"}, headers=WRITER)
    r = client.get("/v1/secrets/staging/payments/new-app", headers=WRITER)
    got = {(x["name"], x["provider"]) for x in r.json()["secrets"]}
    assert got == {("A", "gcp"), ("B", "aws")}
    assert "v1" not in r.text and "v2" not in r.text


def test_secret_then_deploy_flow(make_client, spec_text):
    """New app: deploy is refused until its secrets are set, then goes through."""
    client, _, _ = make_client()
    spec = spec_text.replace("name: payments-api", "name: ledger").split("targets:")[0] + \
        "targets: [{provider: gke, region: us-central1}, {provider: eks, region: us-east-1}]\n"
    assert client.post("/v1/deployments", json=body(spec, "staging"), headers=hdr("staging")).status_code == 422
    client.put("/v1/secrets/staging/payments/ledger/DB_URL", json={"value": "x"}, headers=WRITER)
    client.put("/v1/secrets/staging/payments/ledger/STRIPE_KEY", json={"value": "x", "provider": "aws"}, headers=WRITER)
    assert client.post("/v1/deployments", json=body(spec, "staging"), headers=hdr("staging")).status_code == 202


def test_secret_delete(make_client):
    client, _, _ = make_client()
    url = "/v1/secrets/staging/payments/new-app/A"
    client.put(url, json={"value": "x"}, headers=WRITER)
    assert client.delete(url, headers=WRITER).status_code == 200
    assert client.delete(url, headers=WRITER).status_code == 404


def test_secret_scope_validation(make_client):
    client, _, _ = make_client()
    assert client.put("/v1/secrets/staging/nope/app/A", json={"value": "x"}, headers=WRITER).status_code == 404
    # web has no preview stage
    assert client.put("/v1/secrets/preview/web/site/A", json={"value": "x"},
                      headers={"X-DAAS-Roles": "web.secrets"}).status_code == 404
    assert client.put("/v1/secrets/staging/payments/Bad_App/A", json={"value": "x"}, headers=WRITER).status_code == 422
    assert client.put("/v1/secrets/staging/payments/app/lower", json={"value": "x"}, headers=WRITER).status_code == 422
    # web's default provider is aws
    r = client.put("/v1/secrets/staging/web/site/A", json={"value": "x"}, headers={"X-DAAS-Roles": "web.secrets"})
    assert r.json()["provider"] == "aws"
