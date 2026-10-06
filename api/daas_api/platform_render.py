"""Render every platform-owned Kubernetes/Argo CD object from the platform folder into the GitOps repo.

  platform/argocd/appprojects.yaml      one AppProject per team (own namespaces only, nothing cluster-scoped)
  platform/argocd/applicationsets.yaml  the ApplicationSets that turn the repo into Argo Applications
  platform/<cluster>/namespaces.yaml    team namespaces, preview quotas, read-only RBAC, and secret access
                                        (ServiceAccount + SecretStores for GCP and AWS)

The only object applied by hand is the bootstrap Application (`python -m daas_api.platform_render --bootstrap`),
which points Argo CD at platform/argocd; from then on this module manages everything, including itself.

Runs on API startup (idempotent) or manually:  python -m daas_api.platform_render
"""
import sys

from .config import Settings
from .gitops import GitOpsRepo
from .identity import StageSecrets
from .policy import Cluster, Platform, Team
from .render import to_yaml


def team_namespaces(platform: Platform, cluster: Cluster) -> list[tuple[Team, str, bool]]:
    """Clusters are dedicated: the owning team gets one namespace on it (<ns>-preview in the preview stage)."""
    t = platform.team(cluster.team)
    return [(t, platform.namespace(t, cluster.stage), cluster.stage == platform.preview_stage)]


def secret_access(platform: Platform, team: Team, ns: str, c: Cluster, ts: StageSecrets) -> list[dict]:
    """ServiceAccount + two SecretStores. Both clouds are reachable from both cluster types:

    GKE -> GCP: GKE Workload Identity, impersonating the team's GSA
    EKS -> GCP: Workload Identity Federation (one provider per EKS cluster), same GSA
    any -> AWS: web identity into the team's reader role; the stage's account trusts every cluster issuer
    """
    cv = platform.conventions
    ksa = cv.secretsServiceAccount
    annotations = {"eks.amazonaws.com/role-arn": cv.aws_reader_role(team.name, ts)}
    if c.provider == "gke":
        annotations["iam.gke.io/gcp-service-account"] = cv.gsa_email(team.name, ts)
        gcp_auth = {"workloadIdentity": {
            "clusterProjectID": c.gcpProject, "clusterLocation": c.region, "clusterName": c.name,
            "serviceAccountRef": {"name": ksa}}}
    else:
        gcp_auth = {"workloadIdentityFederation": {
            "audience": cv.wif_audience(c.name, ts),
            "serviceAccountRef": {"name": ksa, "audiences": [cv.wifTokenAudience]},
            "gcpServiceAccountEmail": cv.gsa_email(team.name, ts)}}

    def meta(name):
        return {"name": name, "namespace": ns, "labels": {"daas/team": team.name}}

    return [
        {"apiVersion": "v1", "kind": "ServiceAccount", "metadata": {**meta(ksa), "annotations": annotations}},
        {"apiVersion": "external-secrets.io/v1", "kind": "SecretStore", "metadata": meta(cv.secretStores["gcp"]),
         "spec": {"provider": {"gcpsm": {"projectID": ts.gcp_project, "auth": gcp_auth}}}},
        {"apiVersion": "external-secrets.io/v1", "kind": "SecretStore", "metadata": meta(cv.secretStores["aws"]),
         "spec": {"provider": {"aws": {"service": "SecretsManager", "region": ts.aws_region,
                                       # explicit audience: works the same from EKS and GKE (AWS's OIDC provider
                                       # for each cluster issuer lists sts.amazonaws.com as client ID)
                                       "auth": {"jwt": {"serviceAccountRef": {"name": ksa,
                                                                              "audiences": ["sts.amazonaws.com"]}}}}}}},
    ]


def namespace_guards(c: Cluster, ns: str, team: Team) -> list[dict]:
    """Baseline for every team namespace: default container limits, and ingress only from the same
    namespace, the cluster's Gateway namespace, and namespaces labelled daas/allow-ingress=true
    (e.g. monitoring). Egress stays open."""
    allowed_from = [{"podSelector": {}},
                    {"namespaceSelector": {"matchLabels": {"daas/allow-ingress": "true"}}}]
    if c.gateway:
        allowed_from.append({"namespaceSelector": {"matchLabels": {
            "kubernetes.io/metadata.name": c.gateway["namespace"]}}})
    # Gateways whose data plane isn't a pod in the gateway namespace (GKE managed Gateway, AWS load
    # balancers in IP mode, Envoy Gateway's own namespace, ...) are allowed via clusters.yaml ingressAllow.
    extra = c.ingressAllow or {}
    allowed_from += [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": n}}}
                     for n in extra.get("namespaces") or []]
    allowed_from += [{"ipBlock": {"cidr": cidr}} for cidr in extra.get("cidrs") or []]
    return [
        {"apiVersion": "v1", "kind": "LimitRange", "metadata": {"name": "daas-defaults", "namespace": ns},
         "spec": {"limits": [{"type": "Container",
                              "defaultRequest": {"cpu": "100m", "memory": "128Mi"},
                              "default": {"memory": "512Mi"},
                              "max": {"memory": "16Gi"}}]}},
        {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
         "metadata": {"name": "daas-ingress", "namespace": ns, "labels": {"daas/team": team.name}},
         "spec": {"podSelector": {}, "policyTypes": ["Ingress"], "ingress": [{"from": allowed_from}]}},
    ]


def registry_pull_secret(platform: Platform, team: Team, ns: str) -> dict:
    """imagePullSecret for the platform registry, synced from <team>_<platformSecretsApp>_REGISTRY_AUTH
    (a Docker config JSON, e.g. from a GitLab group deploy token with read_registry)."""
    cv = platform.conventions
    provider = platform.registry.get("provider", team.secrets_provider)
    return {
        "apiVersion": "external-secrets.io/v1", "kind": "ExternalSecret",
        "metadata": {"name": cv.registryPullSecret, "namespace": ns, "labels": {"daas/team": team.name}},
        "spec": {
            "refreshInterval": "1h",
            "secretStoreRef": {"kind": "SecretStore", "name": cv.secretStores[provider]},
            "target": {"name": cv.registryPullSecret,
                       "template": {"type": "kubernetes.io/dockerconfigjson",
                                    "data": {".dockerconfigjson": "{{ .auth }}"}}},
            "data": [{"secretKey": "auth",
                      "remoteRef": {"key": cv.remote_key(team.name, cv.platformSecretsApp, "REGISTRY_AUTH")}}],
        },
    }


def application_sets(repo_url: str) -> list[dict]:
    def appset(name, generators, template):
        return {"apiVersion": "argoproj.io/v1alpha1", "kind": "ApplicationSet",
                "metadata": {"name": name, "namespace": "argocd"},
                "spec": {"goTemplate": True, "goTemplateOptions": ["missingkey=error"],
                         "generators": generators, "template": template}}

    platform_set = appset(
        "daas-platform",
        [{"git": {"repoURL": repo_url, "revision": "main",
                  "directories": [{"path": "platform/*"}, {"path": "platform/argocd", "exclude": True}]}}],
        {"metadata": {"name": "daas-platform-{{ .path.basename }}"},
         "spec": {"project": "default",
                  "source": {"repoURL": repo_url, "targetRevision": "main", "path": "{{ .path.path }}"},
                  "destination": {"name": "{{ .path.basename }}"},
                  "syncPolicy": {"automated": {"prune": False, "selfHeal": True}}}},  # never auto-delete namespaces
    )
    apps_set = appset(
        "daas-apps",
        [{"git": {"repoURL": repo_url, "revision": "main", "files": [{"path": "clusters/*/*/*/daas.json"}]}}],
        {"metadata": {"name": "{{ .cluster }}-{{ .namespace }}-{{ .name }}",  # = health.argo_app_name()
                      "labels": {"daas/team": "{{ .team }}", "daas/cluster": "{{ .cluster }}"},
                      # deleting the directory deletes the Application and its resources
                      "finalizers": ["resources-finalizer.argocd.argoproj.io"]},
         "spec": {"project": "{{ .team }}",
                  "source": {"repoURL": repo_url, "targetRevision": "main", "path": "{{ .path.path }}",
                             "directory": {"include": "manifests.yaml"}},
                  "destination": {"name": "{{ .cluster }}", "namespace": "{{ .namespace }}"},
                  "syncPolicy": {"automated": {"prune": True, "selfHeal": True}}}},
    )
    return [platform_set, apps_set]


def bootstrap(repo_url: str) -> dict:
    """The one object applied by hand: it makes Argo CD manage platform/argocd (and so everything else)."""
    return {"apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
            "metadata": {"name": "daas-bootstrap", "namespace": "argocd"},
            "spec": {"project": "default",
                     "source": {"repoURL": repo_url, "targetRevision": "main", "path": "platform/argocd"},
                     "destination": {"server": "https://kubernetes.default.svc", "namespace": "argocd"},
                     "syncPolicy": {"automated": {"prune": True, "selfHeal": True}}}}


def render_platform(platform: Platform) -> dict[str, str]:
    files: dict[str, str] = {}
    repo_url = platform.gitops_repo

    projects = []
    for t in platform.teams:
        dests = [{"name": c.name, "namespace": ns}
                 for c in platform.clusters for (team, ns, _) in team_namespaces(platform, c) if team is t]
        projects.append({
            "apiVersion": "argoproj.io/v1alpha1", "kind": "AppProject",
            "metadata": {"name": t.name, "namespace": "argocd"},
            "spec": {
                "description": f"DAAS apps for team {t.name}",
                "sourceRepos": [repo_url],
                "destinations": dests,
                "clusterResourceWhitelist": [],  # nothing cluster-scoped
                "namespaceResourceBlacklist": [
                    {"group": "", "kind": "ResourceQuota"},
                    {"group": "", "kind": "LimitRange"},
                    {"group": "rbac.authorization.k8s.io", "kind": "Role"},
                    {"group": "rbac.authorization.k8s.io", "kind": "RoleBinding"},
                    {"group": "external-secrets.io", "kind": "SecretStore"},  # platform-owned
                    {"group": "networking.k8s.io", "kind": "NetworkPolicy"},
                ],
            },
        })
    files["platform/argocd/appprojects.yaml"] = to_yaml(projects)
    files["platform/argocd/applicationsets.yaml"] = to_yaml(application_sets(repo_url))

    for c in platform.clusters:
        docs = []
        for t, ns, is_preview in team_namespaces(platform, c):
            psa = t.pod_security
            docs.append({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": ns, "labels": {
                "daas/team": t.name,
                # Pod Security Admission: reject pods that break the team's standard; warn on anything short of restricted
                "pod-security.kubernetes.io/enforce": psa,
                "pod-security.kubernetes.io/warn": "restricted",
                "pod-security.kubernetes.io/audit": "restricted"}}})
            docs.extend(namespace_guards(c, ns, t))
            if t.group:
                docs.append({
                    "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding",
                    "metadata": {"name": f"{t.name}-view", "namespace": ns},
                    "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "view"},
                    "subjects": [{"apiGroup": "rbac.authorization.k8s.io", "kind": "Group", "name": t.group}],
                })
            if (ts := platform.stage_secrets.get(c.stage)):
                docs.extend(secret_access(platform, t, ns, c, ts))
                if platform.registry:
                    docs.append(registry_pull_secret(platform, t, ns))
            if is_preview and (q := t.preview.get("quota")):
                docs.append({
                    "apiVersion": "v1", "kind": "ResourceQuota",
                    "metadata": {"name": "preview-quota", "namespace": ns},
                    "spec": {"hard": {"requests.cpu": q.get("cpu", "4"), "requests.memory": q.get("memory", "8Gi"),
                                      "limits.memory": q.get("memory", "8Gi")}},
                })
        if docs:
            files[f"platform/{c.name}/namespaces.yaml"] = to_yaml(docs)
    return files


def sync(platform: Platform, repo: GitOpsRepo) -> str:
    return repo.write(render_platform(platform), "platform: sync from platform config")


if __name__ == "__main__":
    s = Settings()
    p = Platform.load(s.platform_dir)
    if "--bootstrap" in sys.argv:
        print(to_yaml([bootstrap(p.gitops_repo)]), end="")
    else:
        repo = GitOpsRepo(s.gitops_path, s.gitops_push, remote=p.gitops_repo, token=s.gitops_token)
        print(f"platform synced at {sync(p, repo)}")
