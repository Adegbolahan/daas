import json

import pytest
import yaml

from daas_api.identity import Conventions
from daas_api.policy import Cluster
from daas_api.render import Placement, render, resolve_secrets, to_yaml
from daas_api.spec import SpecError, parse
from tests.conftest import ROOT

CV = Conventions()
SCHEMA = json.loads((ROOT / "spec" / "daas.schema.json").read_text())
CLUSTER = Cluster(name="payments-gke-usc1-prod", stage="production", team="payments", provider="gke",
                  region="us-central1", gcpProject="acme-payments-prod")
PROD = Placement(CLUSTER, "payments", "payments-api", "payments")
PREVIEW_CLUSTER = Cluster(name="payments-gke-usc1-preview", stage="preview", team="payments", provider="gke",
                          region="us-central1", gcpProject="acme-payments-preview",
                          previewDomain="preview.example.com", gateway={"name": "gw", "namespace": "gateway"})
PREVIEW = Placement(PREVIEW_CLUSTER, "payments-preview", "payments-api-mr-42", "payments", preview=True,
                    hosts=("payments-api-mr-42.preview.example.com",))


def rend(text, image, placement):
    spec = parse(text, SCHEMA)
    return render(spec, image, placement, "d", resolve_secrets(spec, "gcp"), CV)


def edit(text, **changes):
    d = yaml.safe_load(text)
    d.update(changes)
    return yaml.safe_dump(d)


def test_example_renders_expected_kinds(spec_text):
    spec = parse(spec_text, SCHEMA)
    docs = render(spec, "reg/app:1", PROD, "dep-1", resolve_secrets(spec, "gcp"), CV)
    assert [d["kind"] for d in docs] == ["Deployment", "ServiceAccount", "HorizontalPodAutoscaler",
                                         "PodDisruptionBudget", "Service", "ExternalSecret", "ExternalSecret"]
    c = docs[0]["spec"]["template"]["spec"]["containers"][0]
    assert c["image"] == "reg/app:1"
    assert c["ports"] == [{"name": "http", "containerPort": 8080}]
    assert c["readinessProbe"]["httpGet"] == {"path": "/ready", "port": 8080}
    assert c["resources"] == {"requests": {"cpu": "500m", "memory": "512Mi"}, "limits": {"memory": "512Mi"}}
    assert c["envFrom"] == [{"secretRef": {"name": "payments-api-secrets-aws"}},
                            {"secretRef": {"name": "payments-api-secrets-gcp"}}]
    aws, gcp = docs[-2], docs[-1]
    assert aws["spec"]["secretStoreRef"] == {"kind": "SecretStore", "name": "daas-aws"}
    assert aws["spec"]["data"] == [{"secretKey": "STRIPE_KEY", "remoteRef": {"key": "payments_payments-api_STRIPE_KEY"}}]
    assert gcp["spec"]["secretStoreRef"]["name"] == "daas-gcp"
    assert gcp["spec"]["data"][0]["remoteRef"]["key"] == "payments_payments-api_DB_URL"
    assert "replicas" not in docs[0]["spec"]


def test_explicit_image_wins_over_ci_image(spec_text):
    docs = rend(edit(spec_text, image="nginx:1.27"), "reg/app:1", PROD)
    assert docs[0]["spec"]["template"]["spec"]["containers"][0]["image"] == "nginx:1.27"


def test_single_replica_has_no_pdb(spec_text):
    docs = rend(edit(spec_text, scaling={"min": 1, "max": 1}), "i", PROD)
    assert "PodDisruptionBudget" not in [d["kind"] for d in docs]


def test_schema_errors_are_readable(spec_text):
    with pytest.raises(SpecError) as e:
        parse(edit(spec_text, targets=[{"provider": "aks", "region": "eastus1"}]), SCHEMA)
    assert any("targets/0/provider" in m for m in e.value.errors)


def test_unknown_field_rejected(spec_text):
    with pytest.raises(SpecError, match="Additional properties"):
        parse(edit(spec_text, replicas=3), SCHEMA)


def test_duplicate_targets_rejected(spec_text):
    t = {"provider": "gke", "region": "us-central1"}
    with pytest.raises(SpecError, match="duplicate"):
        parse(edit(spec_text, targets=[t, t]), SCHEMA)


def test_secret_provider_default_and_override(spec_text):
    spec = parse(spec_text, SCHEMA)
    assert resolve_secrets(spec, "gcp") == [("DB_URL", "gcp"), ("STRIPE_KEY", "aws")]
    assert resolve_secrets(spec, "aws") == [("DB_URL", "aws"), ("STRIPE_KEY", "aws")]


def test_bad_secret_provider_rejected(spec_text):
    with pytest.raises(SpecError):
        parse(edit(spec_text, secrets=[{"name": "X", "from": "azure"}]), SCHEMA)


def test_env_and_secret_collision_rejected(spec_text):
    with pytest.raises(SpecError, match="both env and secrets"):
        parse(edit(spec_text, env={"DB_URL": "x"}), SCHEMA)


def test_yaml_output_has_no_anchors(spec_text):
    out = to_yaml(rend(spec_text, "i", PROD))
    assert "&id" not in out and "*id" not in out


def test_preview_render(spec_text):
    docs = rend(spec_text, "reg/app:1", PREVIEW)
    kinds = [d["kind"] for d in docs]
    assert "HorizontalPodAutoscaler" not in kinds and "PodDisruptionBudget" not in kinds
    assert docs[0]["spec"]["replicas"] == 1
    route = next(d for d in docs if d["kind"] == "HTTPRoute")
    assert route["spec"]["hostnames"] == ["payments-api-mr-42.preview.example.com"]
    keys = [d["spec"]["data"][0]["remoteRef"]["key"] for d in docs if d["kind"] == "ExternalSecret"]
    # previews use the same key names; the preview stage's stores point at its own secrets
    assert "payments_payments-api_DB_URL" in keys


def test_prod_has_no_httproute(spec_text):
    assert "HTTPRoute" not in [d["kind"] for d in rend(spec_text, "i", PROD)]
