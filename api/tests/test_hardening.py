"""Tests for the review fixes: registry pulls, GitOps remote, health, startup guards, stop rules,
team matching, pod security, ingress, per-stage overrides, identity, workers/cron jobs, durable
records, config reload, notifications and the Argo webhook."""
import shutil
import subprocess

import httpx
import pytest
import yaml

from daas_api.config import Settings
from daas_api.gitops import GitOpsRepo
from daas_api.health import ArgoCDChecker
from daas_api.main import check_settings
from daas_api.notify import ArgoWebhook, Notifier
from daas_api.policy import Platform, PlatformHolder, PolicyError
from daas_api.store import Store
from tests.conftest import ROOT

PROJECT = "acme/payments/payments-api"


def hdr(env="production", project=PROJECT, tier=None):
    h = {"X-DAAS-Project": project, "X-DAAS-Environment": env}
    if tier:
        h["X-DAAS-Tier"] = tier
    return h


def deploy(client, spec, env="production", **kw):
    return client.post("/v1/deployments", headers=hdr(env, **kw),
                       json={"spec": spec, "image": "reg/app:1", "environment": env, "dryRun": True})


def docs_for(resp, cluster):
    plan = next(p for p in resp.json()["plan"] if p["cluster"] == cluster)
    return {d["kind"]: d for d in yaml.safe_load_all(plan["manifests"])}


# ---------- 1. registry pull secrets ----------

def test_pods_use_registry_pull_secret(make_client, spec_text):
    client, repo, _ = make_client()
    r = deploy(client, spec_text)
    pod = docs_for(r, "payments-gke-usc1-prod")["Deployment"]["spec"]["template"]["spec"]
    assert pod["imagePullSecrets"] == [{"name": "daas-registry"}]
    ns_docs = list(yaml.safe_load_all((repo.path / "platform/payments-gke-usc1-prod/namespaces.yaml").read_text()))
    es = next(d for d in ns_docs if d["kind"] == "ExternalSecret")
    assert es["spec"]["target"]["template"]["type"] == "kubernetes.io/dockerconfigjson"
    assert es["spec"]["data"][0]["remoteRef"]["key"] == "payments_daas_REGISTRY_AUTH"


def test_registry_secret_must_be_docker_config(make_client):
    client, _, _ = make_client()
    r = client.put("/v1/secrets/qa/payments/daas/REGISTRY_AUTH", json={"value": "not-json"},
                   headers={"X-DAAS-Roles": "payments.secrets"})
    assert r.status_code == 422


def test_reserved_app_name(make_client, spec_text):
    client, _, _ = make_client()
    r = deploy(client, spec_text.replace("name: payments-api", "name: daas"))
    assert r.status_code == 422 and "reserved" in r.text


# ---------- 2. GitOps remote clone + push ----------

def test_gitops_clones_and_pushes(tmp_path):
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
    seed = GitOpsRepo(tmp_path / "seed")
    subprocess.run(["git", "remote", "add", "origin", str(remote)], cwd=seed.path, check=True)
    subprocess.run(["git", "push", "-q", "origin", "main"], cwd=seed.path, check=True)

    a = GitOpsRepo(tmp_path / "a", push=True, remote=str(remote))
    sha = a.write({"clusters/c/ns/app/manifests.yaml": "x: 1\n"}, "first")
    b = GitOpsRepo(tmp_path / "b", push=True, remote=str(remote))
    assert (b.path / "clusters/c/ns/app/manifests.yaml").exists()
    assert b._git("rev-parse", "HEAD") == sha


def test_gitops_push_requires_remote(tmp_path):
    with pytest.raises(ValueError, match="no repo URL"):
        GitOpsRepo(tmp_path / "x", push=True)


# ---------- 3. health: later revisions that include our commit count ----------

def _argo(revision, health="Healthy"):
    def handler(request):
        return httpx.Response(200, json={"status": {"sync": {"status": "Synced", "revision": revision},
                                                    "health": {"status": health}}})
    return httpx.Client(base_url="http://argo", transport=httpx.MockTransport(handler))


def test_health_accepts_later_revision_containing_ours(tmp_path):
    repo = GitOpsRepo(tmp_path / "g")
    ours = repo.write({"a.yaml": "1"}, "ours")
    later = repo.write({"b.yaml": "2"}, "someone else's deploy")
    ok, _ = ArgoCDChecker("", "", contains=repo.contains, poll_seconds=0, client=_argo(later)).wait(
        "c", "ns", "app", ours, timeout=1)
    assert ok


def test_health_rejects_revision_without_ours(tmp_path):
    repo = GitOpsRepo(tmp_path / "g")
    before = repo._git("rev-parse", "HEAD")
    ours = repo.write({"a.yaml": "1"}, "ours")
    ok, detail = ArgoCDChecker("", "", contains=repo.contains, poll_seconds=0, client=_argo(before)).wait(
        "c", "ns", "app", ours, timeout=0.05)
    assert not ok and "timed out" in detail


# ---------- 4 + 8. startup guards ----------

@pytest.mark.parametrize("kw,msg", [
    ({"auth_mode": "gitlab", "argocd_url": "", "state_db": "/data/daas.db"}, "DAAS_ARGOCD_URL is required"),
    ({"auth_mode": "gitlab", "argocd_url": "http://argo"}, "DAAS_STATE_DB is required"),
    ({"auth_mode": "dev", "gitops_push": True, "secrets_backend": "memory"}, "can't be combined"),
    ({"auth_mode": "dev", "secrets_backend": "cloud"}, "memory"),
    ({"auth_mode": "none"}, "must be gitlab or dev"),
])
def test_unsafe_settings_refused(kw, msg):
    with pytest.raises(RuntimeError, match=msg):
        check_settings(Settings(**kw))


def test_unverified_health_can_be_accepted_explicitly():
    check_settings(Settings(auth_mode="gitlab", argocd_url="", allow_unverified_health=True, state_db="/d.db"))


# ---------- 6. stop only for previews / allowStop ----------

def test_stop_refused_for_production(make_client, spec_text):
    client, _, _ = make_client()
    client.post("/v1/deployments", headers=hdr(), json={"spec": spec_text, "image": "i", "environment": "production"})
    r = client.delete("/v1/environments/production", headers=hdr())
    assert r.status_code == 403 and "allowStop" in r.text


# ---------- 5 + 7. config validation ----------

def _platform_doc():
    from daas_api.policy import load_platform_dir
    return load_platform_dir(ROOT / "platform")


def test_stages_cannot_share_an_account():
    doc = _platform_doc()
    doc["stages"]["uat"]["aws"]["account"] = doc["stages"]["qa"]["aws"]["account"]
    with pytest.raises(ValueError, match="share aws account"):
        Platform(doc)


def test_project_claimed_by_two_teams():
    doc = _platform_doc()
    web = next(t for t in doc["teams"] if t["name"] == "web")
    web["projects"] = web["projects"] + ["acme/payments/*"]
    with pytest.raises(ValueError, match="already claimed"):
        Platform(doc)
    web["projects"] = ["acme/*"]  # overlapping glob: caught when a project matches both
    with pytest.raises(PolicyError, match="matches several teams"):
        Platform(doc).team_for("acme/payments/payments-api")


# ---------- 9. pod security + network policy ----------

def test_namespace_security_baseline(make_client, spec_text):
    client, repo, _ = make_client()
    docs = list(yaml.safe_load_all((repo.path / "platform/payments-gke-usc1-prod/namespaces.yaml").read_text()))
    ns = next(d for d in docs if d["kind"] == "Namespace")
    assert ns["metadata"]["labels"]["pod-security.kubernetes.io/enforce"] == "restricted"
    np = next(d for d in docs if d["kind"] == "NetworkPolicy")
    assert {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "gateway"}}} in np["spec"]["ingress"][0]["from"]
    assert any(d["kind"] == "LimitRange" for d in docs)
    pod = docs_for(deploy(client, spec_text), "payments-gke-usc1-prod")["Deployment"]["spec"]["template"]["spec"]
    assert pod["securityContext"]["runAsNonRoot"] is True
    assert pod["containers"][0]["securityContext"]["capabilities"] == {"drop": ["ALL"]}


# ---------- 11 + 12 + 13. ingress, per-stage overrides, identity ----------

def test_production_ingress_identity_and_overrides(make_client, spec_text):
    client, _, _ = make_client()
    r = deploy(client, spec_text)
    assert r.status_code == 202, r.text
    assert r.json()["urls"] == ["https://pay.example.com", "https://payments-api.payments.example.com"]
    d = docs_for(r, "payments-eks-use1-prod")
    assert d["HTTPRoute"]["spec"]["parentRefs"] == [{"name": "public", "namespace": "gateway"}]
    assert d["ServiceAccount"]["metadata"]["annotations"] == {
        "eks.amazonaws.com/role-arn": "arn:aws:iam::111111111111:role/payments-api"}  # no GKE annotation on EKS
    g = docs_for(r, "payments-gke-usc1-prod")
    assert g["ServiceAccount"]["metadata"]["annotations"]["iam.gke.io/gcp-service-account"].startswith("payments-api@")
    assert {"ServiceMonitor", "PrometheusRule"} <= set(g)            # prometheus-operator feature
    assert g["Deployment"]["metadata"]["annotations"]["secret.reloader.stakater.com/reload"]


def test_stage_overrides_merge(make_client, spec_text):
    client, _, _ = make_client()
    qa = spec_text.split("targets:")[0] + "targets: [{provider: gke, region: us-central1}]\n" + \
        spec_text.split("rollout: { strategy: sequential }\n", 1)[1]
    r = deploy(client, qa, "qa", tier="testing")
    assert r.status_code == 202, r.text
    d = docs_for(r, "payments-gke-usc1-qa")
    assert d["HorizontalPodAutoscaler"]["spec"]["minReplicas"] == 1
    env = {e["name"]: e["value"] for e in d["Deployment"]["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["LOG_LEVEL"] == "debug"
    assert "annotations" not in d["ServiceAccount"]["metadata"]               # identity is production-only
    assert "HTTPRoute" not in d and "no gateway" in r.json()["warnings"][0]   # qa cluster has no gateway


def test_host_outside_team_domains_refused(make_client, spec_text):
    client, _, _ = make_client()
    bad = spec_text.replace("hosts: [pay.example.com, payments-api.payments.example.com]", "hosts: [evil.example.org]")
    r = deploy(client, bad)
    assert r.status_code == 403 and "aren't in team 'payments' domains" in r.text


def test_unknown_stage_override_refused(make_client, spec_text):
    client, _, _ = make_client()
    r = deploy(client, spec_text + "  nope: { scaling: { min: 1 } }\n")
    assert r.status_code == 422 and "unknown stages ['nope']" in r.text


# ---------- 14. workers and scheduled jobs ----------

WORKER = """apiVersion: daas/v1
name: payments-worker
command: [python, worker.py]
secrets: [DB_URL]
targets: [{provider: gke, region: us-central1}]
"""


def test_worker_without_port(make_client, secrets_backend):
    from tests.conftest import STAGES
    secrets_backend.put(STAGES["production"], "gcp", "payments_payments-worker_DB_URL", "x", {})
    client, _, _ = make_client()
    r = deploy(client, WORKER)
    assert r.status_code == 202, r.text
    kinds = set(docs_for(r, "payments-gke-usc1-prod"))
    assert "Deployment" in kinds and "Service" not in kinds and "HTTPRoute" not in kinds


def test_scheduled_job(make_client, secrets_backend):
    from tests.conftest import STAGES
    secrets_backend.put(STAGES["production"], "gcp", "payments_payments-report_DB_URL", "x", {})
    client, _, _ = make_client()
    r = deploy(client, WORKER.replace("payments-worker", "payments-report") + 'schedule: "0 3 * * *"\n')
    d = docs_for(r, "payments-gke-usc1-prod")
    assert d["CronJob"]["spec"]["schedule"] == "0 3 * * *"
    assert not {"Deployment", "HorizontalPodAutoscaler", "Service"} & set(d)


def test_cron_with_port_refused(make_client):
    client, _, _ = make_client()
    r = deploy(client, WORKER + 'schedule: "@daily"\nport: 8080\n')
    assert r.status_code == 422 and "scheduled job can't have port" in r.text


# ---------- 16. durable deployment records ----------

def test_records_survive_restart_and_interrupted_rollouts_fail(tmp_path):
    db = str(tmp_path / "state.db")
    rid = Store(db).create({"status": "running", "clusters": []})["id"]
    again = Store(db)
    assert again.interrupt_unfinished() == [rid]
    assert again.get(rid)["status"] == "failed" and "re-run" in again.get(rid)["message"]


# ---------- 17 + 19. Argo webhook + notifications ----------

def test_argo_webhook_and_notifications(monkeypatch):
    sent = []
    monkeypatch.setattr(httpx, "post", lambda url, json, headers, timeout: sent.append((url, json, headers)))  # noqa: A002
    monkeypatch.setenv("DAAS_ARGOCD_WEBHOOK_URLS", "http://argocd/api/webhook")
    monkeypatch.setenv("DAAS_ARGOCD_WEBHOOK_SECRET", "s")
    ArgoWebhook("https://gitlab.example.com/platform/daas-gitops.git").pushed("abc", ["clusters/x/manifests.yaml"])
    url, body, headers = sent[-1]
    assert headers["X-Gitlab-Event"] == "Push Hook" and headers["X-Gitlab-Token"] == "s"
    assert body["project"]["web_url"] == "https://gitlab.example.com/platform/daas-gitops"

    monkeypatch.setenv("DAAS_NOTIFY_WEBHOOKS", "http://chat/global")
    monkeypatch.setenv("DAAS_NOTIFY_PAYMENTS", "http://chat/payments")
    Notifier().deployment_finished({"status": "failed", "app": "payments-api", "environment": "production",
                                    "stage": "production", "image": "i", "clusters": []}, "DAAS_NOTIFY_PAYMENTS")
    assert [u for u, _, _ in sent[-2:]] == ["http://chat/global", "http://chat/payments"]
    assert "❌ payments-api → production" in sent[-1][1]["text"]


def test_rollout_notifies_when_done(settings, secrets_backend, spec_text):
    from fastapi.testclient import TestClient

    from daas_api.main import create_app
    from tests.conftest import FakeChecker

    seen = []

    class Capture(Notifier):
        def deployment_finished(self, rec, team_env):
            seen.append((rec["status"], team_env))

    client = TestClient(create_app(settings, checker=FakeChecker(), repo=GitOpsRepo(settings.gitops_path),
                                   secrets=secrets_backend, notifier=Capture()))
    client.post("/v1/deployments", headers=hdr(), json={"spec": spec_text, "image": "i", "environment": "production"})
    assert seen == [("succeeded", "DAAS_NOTIFY_PAYMENTS")]


# ---------- 18. platform config reload ----------

def test_platform_reload(tmp_path):
    root = tmp_path / "platform"
    shutil.copytree(ROOT / "platform", root)
    reloaded = []
    h = PlatformHolder(root, interval_seconds=0, on_reload=reloaded.append)
    f = root / "teams/web/access.yaml"
    f.write_text(f.read_text().replace("stages:\n  staging: {}", "stages:\n  staging: {}\n  qa: {}"))
    assert h.reload_if_changed() and "qa" in h.current.team("web").stages and len(reloaded) == 1
    f.write_text(f.read_text().replace("qa: {}", "nope: {}"))
    assert not h.reload_if_changed()
    assert "unknown stages" in h.last_error and "qa" in h.current.team("web").stages  # last good config kept


# ---------- audit follow-ups ----------

def test_reload_survives_any_bad_config_and_render_failures(tmp_path):
    root = tmp_path / "platform"
    shutil.copytree(ROOT / "platform", root)
    calls = []

    def boom(p):
        calls.append(p)
        raise RuntimeError("git push failed")

    h = PlatformHolder(root, interval_seconds=0, on_reload=boom)
    st = root / "stages.yaml"
    original = st.read_text()
    st.write_text(original.replace('projectNumber: "100000000004"', ""))        # missing key
    assert not h.reload_if_changed() and "projectNumber" in h.last_error
    st.write_text(original)
    conv = root / "conventions.yaml"
    conv.write_text(conv.read_text().replace('secretKeySeparator: "_"', 'secretKeySeparator: "__"'))
    assert not h.reload_if_changed() and "restart DAAS" in h.last_error        # renames need a restart
    conv.write_text((ROOT / "platform/conventions.yaml").read_text())
    web = root / "teams/web/access.yaml"
    web.write_text(web.read_text() + "\n# touched\n")
    assert h.reload_if_changed() and calls and "re-rendering platform objects failed" in h.last_error


def test_git_token_never_in_errors_or_argv(tmp_path, monkeypatch):
    seen = []
    real = subprocess.run

    def spy(args, **kw):
        seen.append(" ".join(args))
        return real(args, **kw)

    monkeypatch.setattr(subprocess, "run", spy)
    from daas_api.gitops import GitError
    with pytest.raises(GitError) as e:
        GitOpsRepo(tmp_path / "x", push=True, remote="http://127.0.0.1:9/nope.git", token="s3cr3t-token")
    import base64
    b64 = base64.b64encode(b"oauth2:s3cr3t-token").decode()
    assert "s3cr3t" not in str(e.value) and b64 not in str(e.value)
    assert not any("s3cr3t" in a or b64 in a for a in seen)


def test_rollout_error_marks_failed():
    from daas_api import rollout
    store = Store()
    rid = store.create({"status": "pending", "clusters": []})["id"]

    class Broken:
        def write(self, *a, **k):
            raise KeyError("boom")

    done = []
    rollout.execute(rid, [[]], {}, "x", Broken(), None, store, 1, on_done=done.append)
    assert store.get(rid)["status"] == "failed" and done[0]["status"] == "failed"


def test_health_survives_non_json(tmp_path):
    client = httpx.Client(base_url="http://argo", transport=httpx.MockTransport(
        lambda r: httpx.Response(200, text="<html>proxy</html>")))
    ok, detail = ArgoCDChecker("", "", poll_seconds=0, client=client).wait("c", "ns", "a", "sha", timeout=0.05)
    assert not ok and "non-JSON" in detail


def test_worker_preview_has_no_url(make_client, secrets_backend):
    from tests.conftest import STAGES
    secrets_backend.put(STAGES["preview"], "gcp", "payments_payments-worker_DB_URL", "x", {})
    client, _, _ = make_client()
    r = deploy(client, WORKER, "review/mr-5")
    assert r.status_code == 202 and "url" not in r.json()


def test_gateway_extras_and_monitoring_labels(make_client, spec_text):
    client, repo, _ = make_client()
    docs = list(yaml.safe_load_all((repo.path / "platform/payments-gke-usc1-prod/namespaces.yaml").read_text()))
    np = next(d for d in docs if d["kind"] == "NetworkPolicy")
    assert {"ipBlock": {"cidr": "35.191.0.0/16"}} in np["spec"]["ingress"][0]["from"]
    g = docs_for(deploy(client, spec_text), "payments-gke-usc1-prod")
    assert g["PrometheusRule"]["metadata"]["labels"]["release"] == "kube-prometheus-stack"
    expr = g["PrometheusRule"]["spec"]["groups"][0]["rules"][1]["expr"]
    assert 'pod=~"payments-api-[a-z0-9]+-[a-z0-9]+"' in expr
