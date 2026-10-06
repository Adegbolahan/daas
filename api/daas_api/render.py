"""Render an app's daas.yaml (already merged for its stage) into Kubernetes manifests for one cluster."""
from dataclasses import dataclass, field

import yaml

from .identity import Conventions
from .policy import Cluster
from .spec import AppSpec


@dataclass(frozen=True)
class Placement:
    """Where one copy of the app lands, and the platform settings that apply there."""
    cluster: Cluster
    namespace: str                 # e.g. payments, or payments-preview
    name: str                      # deployed name, e.g. payments-api, or payments-api-mr-42
    team: str                      # owning team, used for secret key names
    preview: bool = False
    hosts: tuple[str, ...] = ()    # public hostnames (HTTPRoute); empty = cluster-internal only
    pod_security: str = "restricted"
    pull_secret: str | None = None  # imagePullSecret name, when the platform registry is configured
    ingress_path: str = "/"
    extra: dict = field(default_factory=dict)

    @property
    def host(self) -> str | None:
        return self.hosts[0] if self.hosts else None


def _probe(path: str | None, port: int) -> dict | None:
    if not path:
        return None
    return {"httpGet": {"path": path, "port": port}, "periodSeconds": 10, "failureThreshold": 3}


def resolve_secrets(spec: AppSpec, default_provider: str) -> list[tuple[str, str]]:
    """[(NAME, provider)] with the team default filled in."""
    return [(s["name"], s["from"] or default_provider) for s in spec.secrets]


def render(spec: AppSpec, ci_image: str, p: Placement, deployment_id: str,
           secrets: list[tuple[str, str]], conv: Conventions) -> list[dict]:
    by_provider: dict[str, list[str]] = {}
    for n, prov in secrets:
        by_provider.setdefault(prov, []).append(n)
    secret_names = [f"{p.name}-secrets-{prov}" for prov in sorted(by_provider)]
    name = p.name
    labels = {"app.kubernetes.io/name": name, "app.kubernetes.io/part-of": spec.name,
              "app.kubernetes.io/managed-by": "daas"}
    selector = {"app.kubernetes.io/name": name}
    meta = {"name": name, "namespace": p.namespace, "labels": labels}

    # --- container + pod ---------------------------------------------------------------------------
    container = {
        "name": "app",
        "image": spec.image or ci_image,
        "env": [{"name": k, "value": str(v)} for k, v in spec.env.items()],
        # CPU limit left off on purpose (avoids throttling); memory limit = request.
        "resources": {
            "requests": {"cpu": spec.resources["cpu"], "memory": spec.resources["memory"]},
            "limits": {"memory": spec.resources["memory"]},
        },
        "securityContext": {"allowPrivilegeEscalation": False, "capabilities": {"drop": ["ALL"]}},
    }
    if spec.port:
        container["ports"] = [{"name": "http", "containerPort": spec.port}]
    if secret_names:
        container["envFrom"] = [{"secretRef": {"name": n}} for n in secret_names]
    if spec.command:
        container["command"] = spec.command
    if spec.args:
        container["args"] = spec.args
    if spec.port:
        for key, probe in (("liveness", "livenessProbe"), ("readiness", "readinessProbe")):
            if (pr := _probe(spec.health.get(key), spec.port)):
                container[probe] = pr

    pod_security_context = {"seccompProfile": {"type": "RuntimeDefault"}}
    if p.pod_security == "restricted":
        pod_security_context["runAsNonRoot"] = True
    pod_annotations = {"daas/deployment-id": deployment_id}
    if spec.metrics is not None:
        pod_annotations.update({"prometheus.io/scrape": "true", "prometheus.io/path": spec.metrics["path"],
                                "prometheus.io/port": str(spec.metrics.get("port") or spec.port)})
    pod_spec = {
        "serviceAccountName": name,
        "securityContext": pod_security_context,
        "containers": [container],
    }
    if p.pull_secret:
        pod_spec["imagePullSecrets"] = [{"name": p.pull_secret}]
    template = {"metadata": {"labels": labels, "annotations": pod_annotations}, "spec": pod_spec}

    # Restart pods when their secrets rotate (needs stakater/Reloader on the cluster; harmless otherwise).
    workload_meta = {**meta, "annotations": {"secret.reloader.stakater.com/reload": ",".join(secret_names)}} \
        if secret_names else meta

    # --- identity ------------------------------------------------------------------------------------
    sa_annotations = {}
    if spec.identity.get("awsRoleArn"):
        sa_annotations["eks.amazonaws.com/role-arn"] = spec.identity["awsRoleArn"]
    if spec.identity.get("gcpServiceAccount") and p.cluster.provider == "gke":
        sa_annotations["iam.gke.io/gcp-service-account"] = spec.identity["gcpServiceAccount"]
    sa = {"apiVersion": "v1", "kind": "ServiceAccount",
          "metadata": {**meta, **({"annotations": sa_annotations} if sa_annotations else {})}}

    docs: list[dict] = []
    # --- workload ------------------------------------------------------------------------------------
    if spec.kind == "cronjob":
        pod_spec["restartPolicy"] = "OnFailure"
        docs.append({
            "apiVersion": "batch/v1", "kind": "CronJob", "metadata": workload_meta,
            "spec": {"schedule": spec.schedule, "concurrencyPolicy": "Forbid",
                     "successfulJobsHistoryLimit": 3, "failedJobsHistoryLimit": 3,
                     "jobTemplate": {"spec": {"backoffLimit": 2, "template": template}}},
        })
    else:
        pod_spec["topologySpreadConstraints"] = [{
            "maxSkew": 1, "topologyKey": "topology.kubernetes.io/zone",
            "whenUnsatisfiable": "ScheduleAnyway", "labelSelector": {"matchLabels": selector}}]
        deployment_spec = {
            "selector": {"matchLabels": selector},
            "strategy": {"rollingUpdate": {"maxUnavailable": 0, "maxSurge": "25%"}},
            "template": template,
        }
        if p.preview:
            deployment_spec["replicas"] = 1  # previews: fixed single replica, no HPA/PDB
        docs.append({"apiVersion": "apps/v1", "kind": "Deployment", "metadata": workload_meta,
                     "spec": deployment_spec})
    docs.append(sa)

    if spec.kind != "cronjob" and not p.preview:
        docs.append({
            "apiVersion": "autoscaling/v2", "kind": "HorizontalPodAutoscaler", "metadata": meta,
            "spec": {
                "scaleTargetRef": {"apiVersion": "apps/v1", "kind": "Deployment", "name": name},
                "minReplicas": spec.scaling["min"],
                "maxReplicas": spec.scaling["max"],
                "metrics": [{"type": "Resource", "resource": {
                    "name": "cpu", "target": {"type": "Utilization", "averageUtilization": spec.scaling["targetCPU"]}}}],
            },
        })
        if spec.scaling["min"] > 1:
            docs.append({
                "apiVersion": "policy/v1", "kind": "PodDisruptionBudget", "metadata": meta,
                "spec": {"maxUnavailable": 1, "selector": {"matchLabels": selector}},
            })

    # --- networking ----------------------------------------------------------------------------------
    if spec.port:
        docs.append({
            "apiVersion": "v1", "kind": "Service", "metadata": meta,
            "spec": {"selector": selector,
                     "ports": [{"name": "http", "port": 80, "targetPort": "http", "protocol": "TCP"}]},
        })
    if p.hosts and p.cluster.gateway and spec.port:
        docs.append({
            "apiVersion": "gateway.networking.k8s.io/v1", "kind": "HTTPRoute", "metadata": meta,
            "spec": {
                "parentRefs": [{"name": p.cluster.gateway["name"], "namespace": p.cluster.gateway["namespace"]}],
                "hostnames": list(p.hosts),
                "rules": [{"matches": [{"path": {"type": "PathPrefix", "value": p.ingress_path}}],
                           "backendRefs": [{"name": name, "port": 80}]}],
            },
        })

    # --- secrets -------------------------------------------------------------------------------------
    # One ExternalSecret per provider, each via the team's namespaced SecretStore (conventions.secretStores).
    # Remote keys are <team>_<app>_<NAME>: built here, never by the app, and the store's identity can only
    # read the team's own prefix. Previews use the same names; the preview stage's stores point at its own secrets.
    for prov in sorted(by_provider):
        target = f"{name}-secrets-{prov}"
        docs.append({
            "apiVersion": "external-secrets.io/v1", "kind": "ExternalSecret",
            "metadata": {**meta, "name": target},
            "spec": {
                "refreshInterval": "1h",
                "secretStoreRef": {"kind": "SecretStore", "name": conv.secretStores[prov]},
                "target": {"name": target},
                "data": [{"secretKey": n, "remoteRef": {"key": conv.remote_key(p.team, spec.name, n)}}
                         for n in by_provider[prov]],
            },
        })

    # --- observability ---------------------------------------------------------------------------------
    mon_meta = {**meta, "labels": {**labels, **(p.cluster.monitoringLabels or {})}}
    if spec.metrics is not None and "prometheus-operator" in p.cluster.features:
        mport = spec.metrics.get("port") or spec.port
        if spec.kind == "service" and mport == spec.port:
            docs.append({
                "apiVersion": "monitoring.coreos.com/v1", "kind": "ServiceMonitor", "metadata": mon_meta,
                "spec": {"selector": {"matchLabels": selector},
                         "endpoints": [{"port": "http", "path": spec.metrics["path"], "interval": "30s"}]},
            })
        else:
            docs.append({
                "apiVersion": "monitoring.coreos.com/v1", "kind": "PodMonitor", "metadata": mon_meta,
                "spec": {"selector": {"matchLabels": selector},
                         "podMetricsEndpoints": [{"targetPort": mport, "path": spec.metrics["path"],
                                                  "interval": "30s"}]},
            })
    if "prometheus-operator" in p.cluster.features and spec.kind != "cronjob":
        ns, alert_labels = p.namespace, {"team": p.team, "app": spec.name}
        docs.append({
            "apiVersion": "monitoring.coreos.com/v1", "kind": "PrometheusRule", "metadata": mon_meta,
            "spec": {"groups": [{"name": f"daas-{name}", "rules": [
                {"alert": "DaasAppUnavailable",
                 "expr": f'kube_deployment_status_replicas_available{{namespace="{ns}",deployment="{name}"}} == 0',
                 "for": "5m", "labels": {**alert_labels, "severity": "critical"},
                 "annotations": {"summary": f"{name} in {ns} has no available replicas"}},
                {"alert": "DaasAppCrashLooping",
                 # =~ is fully anchored: only <name>-<replicaset hash>-<pod hash>, so "api" doesn't match "api-worker-…"
                 "expr": f'increase(kube_pod_container_status_restarts_total{{namespace="{ns}",'
                         f'pod=~"{name}-[a-z0-9]+-[a-z0-9]+"}}[15m]) > 3',
                 "for": "5m", "labels": {**alert_labels, "severity": "warning"},
                 "annotations": {"summary": f"{name} in {ns} is restarting repeatedly"}},
            ]}]},
        })
    return docs


class _NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data):
        return True


def to_yaml(docs: list[dict]) -> str:
    return yaml.dump_all(docs, Dumper=_NoAliasDumper, sort_keys=False)
