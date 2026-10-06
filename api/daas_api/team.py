"""What a team gets from the platform, computed from the platform folder (nothing hand-written).

  python -m daas_api.team payments          # print one team's page
  python -m daas_api.team --write           # regenerate teams/<team>/README.md for every team + CODEOWNERS
  python -m daas_api.team --check           # fail if any generated file is stale (CI)
"""
import argparse
import sys
from pathlib import Path

from .config import Settings
from .policy import Platform, Team

REPO_ROOT = Path(__file__).resolve().parents[2]
PER_APP = ["Deployment (zone-spread, maxUnavailable 0), or a CronJob when daas.yaml has `schedule`",
           "ServiceAccount <app>, annotated from `identity` (GKE Workload Identity / EKS IRSA)",
           "HorizontalPodAutoscaler, and a PodDisruptionBudget when scaling.min > 1",
           "Service :80 when the app has a port",
           "HTTPRoute on the cluster Gateway for `ingress` (and for every preview)",
           "ExternalSecret per provider -> Secret <app>-secrets-<gcp|aws>, injected as env; pods restart on "
           "rotation (Reloader)",
           "imagePullSecret for the platform registry",
           "ServiceMonitor/PodMonitor for `metrics`, and availability/crash-loop alerts, where prometheus-operator runs"]


def describe(platform: Platform, team: Team) -> dict:
    cv = platform.conventions
    stages = {}
    for name, rules in team.stages.items():
        st = platform.stages[name]
        ns = platform.namespace(team, name)
        ss = platform.stage_secrets.get(name)
        entry = {
            "gitlabTier": st.gitlab_tier,
            "environments": list(st.environments),
            "gates": {"protectedBranchOnly": bool(rules.get("protectedRefOnly")),
                      "protectedEnvironment": bool(rules.get("requireProtectedEnvironment"))},
            "namespace": ns,
            "clusters": [{"name": c.name, "cloud": c.provider, "region": c.region,
                          "publicDomain": c.domain if c.gateway else None, "features": list(c.features)}
                         for c in platform.team_clusters(team, name)],
        }
        if ss:
            entry["secrets"] = {
                "writersRole": team.secret_writer(name),
                "gcp": {"project": ss.gcp_project, "readerServiceAccount": cv.gsa_email(team.name, ss)},
                "aws": {"account": ss.aws_account, "region": ss.aws_region,
                        "readerRole": cv.aws_reader_role(team.name, ss)},
            }
        if st.preview:
            pc = platform.preview_cluster(team)
            entry["previews"] = {
                "url": f"https://<app>-mr-<iid>.{pc.previewDomain}" if pc and pc.previewDomain else None,
                "maxConcurrent": team.preview.get("maxConcurrent", 5),
                "quota": team.preview.get("quota"),
                "lifetime": "removed on MR merge/close, or after DAAS_PREVIEW_TTL_HOURS without a push",
            }
        stages[name] = entry
    return {
        "team": team.name,
        "owners": list(team.owners),
        "gitlabProjects": list(team.projects),
        "readOnlyKubernetesGroup": team.group or None,
        "podSecurity": team.pod_security,
        "ingressDomains": list(team.domains),
        "notifyWebhookEnv": team.notify_env,
        "argoProject": team.name,
        "secrets": {"defaultProvider": team.secrets_provider,
                    "keyFormat": cv.remote_key(team.name, "<app>", "<NAME>"),
                    "keyPrefix": f"{team.name}{cv.secretKeySeparator}",
                    "kubernetesServiceAccount": cv.secretsServiceAccount,
                    "secretStores": cv.secretStores},
        "stages": stages,
    }


def to_markdown(d: dict) -> str:
    L = [f"# Team `{d['team']}`", "",
         "_Generated from this folder and the platform files by `python -m daas_api.team --write`. "
         "Edit `access.yaml`, `clusters.yaml` or `secrets.yaml`, not this file._", "",
         "## Access", "",
         f"- **Folder owners:** {', '.join(d['owners']) or 'none'} (plus the platform team)",
         f"- **GitLab projects that can deploy:** {', '.join(f'`{p}`' for p in d['gitlabProjects'])}",
         f"- **Argo CD project:** `{d['argoProject']}`. It can only touch this team's namespaces on this "
         "team's clusters. No cluster-scoped objects, quotas, RBAC, NetworkPolicies or SecretStores",
         (f"- **Read-only kubectl:** group `{d['readOnlyKubernetesGroup']}`" if d["readOnlyKubernetesGroup"]
          else "- **Read-only kubectl:** none (no `group` set)"),
         f"- **Pod Security Standard:** `{d['podSecurity']}` on every namespace, plus a default-deny ingress "
         "NetworkPolicy (same namespace, the cluster Gateway, and namespaces labelled `daas/allow-ingress=true` "
         "are allowed)",
         (f"- **Hosts apps may claim** (`ingress.hosts`): {', '.join(f'`{x}`' for x in d['ingressDomains'])}"
          if d["ingressDomains"] else "- **Hosts apps may claim:** none. Apps get only the default `<app>.<cluster domain>`"),
         (f"- **Deploy notifications:** the webhook in DAAS env var `{d['notifyWebhookEnv']}`"
          if d["notifyWebhookEnv"] else "- **Deploy notifications:** global webhooks only"),
         "", "## Stages", ""]
    for name, t in d["stages"].items():
        g = t["gates"]
        gates = [x for x, on in (("protected branch", g["protectedBranchOnly"]),
                                 ("protected environment + approvals", g["protectedEnvironment"])) if on]
        L += [f"### {name}", "",
              f"- **GitLab environments:** {', '.join(f'`{e}`' for e in t['environments'])} "
              f"(jobs declare `deployment_tier: {t['gitlabTier']}`)",
              f"- **Gates:** {', '.join(gates) or 'none'}",
              f"- **Namespace:** `{t['namespace']}`"]
        if t["clusters"]:
            L += ["- **Clusters:**"] + [
                f"  - `{c['name']}` ({c['cloud']}, {c['region']})"
                + (f", public apps at `<app>.{c['publicDomain']}`" if c["publicDomain"] else ", no public ingress")
                + (f", {', '.join(c['features'])}" if c["features"] else "")
                for c in t["clusters"]]
        else:
            L.append("- **Clusters:** none yet. Add them to `clusters.yaml`")
        if "secrets" in t:
            s = t["secrets"]
            L += [f"- **Secrets:** written by Entra role `{s['writersRole']}`; stored in GCP `{s['gcp']['project']}` "
                  f"/ AWS `{s['aws']['account']}` ({s['aws']['region']})",
                  f"  - read as GCP `{s['gcp']['readerServiceAccount']}` and AWS `{s['aws']['readerRole']}`"]
        if "previews" in t:
            p = t["previews"]
            q = p["quota"] or {}
            L += [f"- **Previews:** URL `{p['url']}`, up to {p['maxConcurrent']} at once"
                  + (f", quota {q.get('cpu')} CPU / {q.get('memory')}" if q else "") + f"; {p['lifetime']}"]
        L.append("")
    s = d["secrets"]
    L += ["## Secrets", "",
          f"- **Default provider:** `{s['defaultProvider']}` (override per secret in an app's daas.yaml with `from:`)",
          f"- **Key format:** `{s['keyFormat']}`. This team's identities can read only keys that start with "
          f"`{s['keyPrefix']}`",
          f"- **In every namespace:** ServiceAccount `{s['kubernetesServiceAccount']}`, SecretStores "
          f"`{s['secretStores']['gcp']}` and `{s['secretStores']['aws']}`",
          "", "## Every app gets", ""] + [f"- {x}" for x in PER_APP] + [""]
    return "\n".join(L)


def codeowners(platform: Platform, platform_dir: Path) -> str:
    rel = "/" + platform_dir.resolve().relative_to(REPO_ROOT).as_posix() + "/"
    owners = " ".join(platform.platform_owners)
    L = ["# Generated by `python -m daas_api.team --write`. Don't edit by hand.",
         "# A change to a team folder needs approval from the team's owners AND the platform team.", "",
         "[Platform]", f"{rel} {owners}", f"/terraform/ {owners}", f"/api/ {owners}",
         f"/gitlab-component/ {owners}", f"/.gitlab-ci.yml {owners}", ""]
    for t in platform.teams:
        if t.owners:
            L += [f"[Team {t.name}]", f"{rel}teams/{t.name}/ {' '.join(t.owners)}", ""]
    return "\n".join(L)


def generated_files(platform: Platform, platform_dir: Path) -> dict[Path, str]:
    files = {platform_dir / "teams" / t.name / "README.md": to_markdown(describe(platform, t)) for t in platform.teams}
    files[REPO_ROOT / ".gitlab" / "CODEOWNERS"] = codeowners(platform, platform_dir)
    return files


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("team", nargs="?")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    s = Settings()
    platform = Platform.load(s.platform_dir)
    if a.write or a.check:
        stale = []
        for path, content in generated_files(platform, s.platform_dir).items():
            if not path.exists() or path.read_text() != content:
                stale.append(path)
                if a.write:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(content)
        for p in stale:
            print(("wrote " if a.write else "stale: ") + str(p.resolve().relative_to(REPO_ROOT)))
        if a.check and stale:
            print("run: cd api && python -m daas_api.team --write")
            sys.exit(1)
        return
    if not a.team:
        ap.error("give a team name, or --write / --check")
    sys.stdout.write(to_markdown(describe(platform, platform.team(a.team))))


if __name__ == "__main__":
    main()
