"""Platform config and the authorization rules.

The platform repo folder (DAAS_PLATFORM_DIR) holds:
  stages.yaml, conventions.yaml, service.yaml, terraform.yaml     platform-owned
  teams/<team>/access.yaml, clusters.yaml, secrets.yaml             one folder per team

The unit of isolation is a **stage**: its own secrets project/account and Terraform state, with
each team running dedicated clusters in it. You can have any number of stages. A GitLab environment name is routed to a stage by the
stage's `environments` globs. Each stage also names the GitLab deployment tier its jobs must
declare, which is what GitLab's (group-level) protected environments key on. Several stages can
share a tier, e.g. qa, uat and perf all on `testing`.
"""
import re
from dataclasses import dataclass, field
from fnmatch import fnmatch
from pathlib import Path

import yaml

from .identity import Conventions, StageSecrets, stage_secrets

GITLAB_TIERS = ("production", "staging", "testing", "development", "other")
STAGE_NAME = re.compile(r"^[a-z][a-z0-9-]{0,20}$")
DNS_LABEL = re.compile(r"^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$")


class PolicyError(PermissionError):
    pass


@dataclass(frozen=True)
class Stage:
    name: str
    gitlab_tier: str
    environments: tuple[str, ...]
    preview: bool = False
    auto_apply: bool = True
    partial_targets: bool = False  # deploy to the app's targets that exist here, skip the rest
    allow_stop: bool = False       # GitLab "stop environment" may delete apps here (always true for previews)

    def match(self, env_name: str) -> str | None:
        """The glob that routes env_name here, if any."""
        return next((p for p in self.environments if fnmatch(env_name, p)), None)


@dataclass(frozen=True)
class Cluster:
    name: str
    stage: str
    team: str
    provider: str
    region: str
    gcpProject: str | None = None     # GKE: project the cluster runs in
    oidcIssuer: str | None = None     # EKS: cluster OIDC issuer URL
    previewDomain: str | None = None  # preview stage: each preview gets <name>.<previewDomain>
    domain: str | None = None         # other stages: default public host <app>.<domain>
    gateway: dict | None = None       # {name, namespace}: Gateway API gateway for HTTPRoutes
    features: tuple = ()              # optional add-ons installed here, e.g. prometheus-operator
    ingressAllow: dict | None = None  # extra NetworkPolicy sources: {namespaces: [...], cidrs: [...]}
    monitoringLabels: dict | None = None  # labels Prometheus selects on, e.g. {release: kube-prometheus-stack}


@dataclass(frozen=True)
class Team:
    name: str
    namespace: str
    group: str
    projects: tuple[str, ...]
    stages: dict
    owners: tuple[str, ...] = ()
    preview: dict = field(default_factory=dict)
    secrets: dict = field(default_factory=dict)
    domains: tuple[str, ...] = ()     # host globs apps may claim for ingress
    pod_security: str = "restricted"  # Pod Security Standard enforced on the team's namespaces
    notify_env: str | None = None     # env var holding the team's deploy-notification webhook URL

    @property
    def secrets_provider(self) -> str:
        return self.secrets.get("provider", "gcp")

    def secret_writer(self, stage: str) -> str | None:
        w = self.secrets.get("writers") or {}
        return w.get(stage, w.get("default"))


@dataclass(frozen=True)
class EnvRef:
    """A GitLab environment resolved to a stage.

    'production'   -> stage production,            deployed as <app>
    'qa-2'         -> stage qa (glob qa-*),         deployed as <app>
    'review/mr-42' -> stage preview (review/*),     deployed as <app>-mr-42
    """
    name: str
    stage: str
    tier: str
    preview: bool = False
    slug: str | None = None

    @property
    def is_preview(self) -> bool:
        return self.preview


def infer_tier(name: str) -> str:
    """GitLab's own inference from an environment name (fallback for dev-mode auth only)."""
    n = name.lower()
    for tier, pat in (("production", r"^(prod|production|live)"), ("staging", r"^(stag|model|pre)"),
                      ("testing", r"^(test|qa|uat)"), ("development", r"^(dev|review|trunk)")):
        if re.match(pat, n):
            return tier
    return "other"


def preview_slug(env_name: str, pattern: str) -> str:
    prefix = pattern.split("*", 1)[0] if "*" in pattern else ""
    raw = env_name[len(prefix):] if prefix and env_name.startswith(prefix) else env_name
    slug = re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")[:20].strip("-")
    if not slug:
        raise PolicyError(f"invalid preview environment name '{env_name}'")
    return slug


def _read(path: Path, default):
    return (yaml.safe_load(path.read_text()) or default) if path.exists() else default


TEAM_SCHEMAS = {"access.yaml": "team-access.schema.json", "clusters.yaml": "team-clusters.schema.json",
                "secrets.yaml": "team-secrets.schema.json"}


def _validate_team_file(schemas_dir: Path | None, path: Path, doc) -> None:
    if not schemas_dir:
        return
    import json

    import jsonschema
    schema = json.loads((schemas_dir / TEAM_SCHEMAS[path.name]).read_text())
    errs = sorted(jsonschema.Draft202012Validator(schema).iter_errors(doc), key=lambda e: list(e.path))
    if errs:
        e = errs[0]
        where = "/".join(map(str, e.path)) or "(root)"
        raise ValueError(f"teams/{path.parent.name}/{path.name}: {where}: {e.message}")


def load_platform_dir(root: Path, schemas_dir: Path | None = None) -> dict:
    """Read the platform folder into one dict (the shape Platform takes).

    schemas_dir: validate each team file against spec/team-*.schema.json (the same schemas the
    Backstage onboarding template is generated from)."""
    teams = []
    for d in sorted(p for p in (root / "teams").iterdir() if (p / "access.yaml").exists()) \
            if (root / "teams").is_dir() else []:
        t = _read(d / "access.yaml", {})
        _validate_team_file(schemas_dir, d / "access.yaml", t)
        if t.get("name", d.name) != d.name:
            raise ValueError(f"{d}/access.yaml: name '{t['name']}' must match its folder '{d.name}'")
        if not (d / "clusters.yaml").exists():
            raise ValueError(f"{d}/clusters.yaml is missing (use `[]` until the team has clusters)")
        clusters = _read(d / "clusters.yaml", [])
        if not isinstance(clusters, list):
            raise ValueError(f"{d}/clusters.yaml must be a list of clusters")
        _validate_team_file(schemas_dir, d / "clusters.yaml", clusters)
        secrets = _read(d / "secrets.yaml", {})
        _validate_team_file(schemas_dir, d / "secrets.yaml", secrets)
        teams.append({**t, "name": d.name, "clusters": clusters, "secrets": secrets})
    return {"stages": _read(root / "stages.yaml", {}), "conventions": _read(root / "conventions.yaml", {}),
            "service": _read(root / "service.yaml", {}), "teams": teams}


class Platform:
    def __init__(self, doc: dict):
        """doc: {stages, conventions, service, teams: [{..access.yaml, clusters, secrets}]} (see load_platform_dir)."""
        self.doc = doc
        self.conventions = Conventions.from_dict(doc.get("conventions"))
        service = doc.get("service") or {}
        self.gitops_repo: str = service.get("gitopsRepo", "")
        self.platform_owners: list[str] = list(service.get("platformOwners") or [])
        raw_stages: dict = doc.get("stages") or {}
        self.stages: dict[str, Stage] = {
            n: Stage(n, v.get("gitlabTier", ""), tuple(v.get("environments") or [n]),
                     bool(v.get("preview")), v.get("autoApply", True), bool(v.get("partialTargets")),
                     bool(v.get("preview") or v.get("allowStop")))
            for n, v in raw_stages.items()}
        self.stage_secrets: dict[str, StageSecrets] = stage_secrets(raw_stages)
        self.clusters = []
        for x in doc.get("teams") or []:
            for c in x.get("clusters") or []:
                try:
                    self.clusters.append(Cluster(**{**c, "team": x["name"], "features": tuple(c.get("features") or ())}))
                except TypeError as e:
                    raise ValueError(f"teams/{x['name']}/clusters.yaml: {c.get('name')}: {e}") from None
        self.teams = [Team(x["name"], x.get("namespace", x["name"]), x.get("group", ""), tuple(x.get("projects") or []),
                           x.get("stages") or {}, tuple(x.get("owners") or []), x.get("preview") or {},
                           x.get("secrets") or {}, tuple(x.get("domains") or []),
                           x.get("podSecurity", self.conventions.defaultPodSecurity),
                           (x.get("notify") or {}).get("webhookEnv"))
                      for x in doc.get("teams") or []]
        self.registry: dict = service.get("registry") or {}
        self._validate()        # stages + clusters
        self._validate_teams()
        self.preview_stage = next((s.name for s in self.stages.values() if s.preview), None)

    def _validate(self) -> None:
        for s in self.stages.values():
            if not STAGE_NAME.match(s.name):
                raise ValueError(f"stages.yaml: '{s.name}' must match {STAGE_NAME.pattern}")
            if s.gitlab_tier not in GITLAB_TIERS:
                raise ValueError(f"stages.yaml: {s.name}.gitlabTier must be one of {GITLAB_TIERS}")
        if sum(1 for s in self.stages.values() if s.preview) > 1:
            raise ValueError("stages.yaml: at most one stage can be `preview: true`")
        # Identities are named per team, not per stage: two stages in one account/project would collide.
        for cloud, key in (("gcp", "project"), ("aws", "account")):
            homes: dict[str, str] = {}
            for name, v in (self.doc.get("stages") or {}).items():
                home = str((v.get(cloud) or {}).get(key, ""))
                if home and home in homes:
                    raise ValueError(f"stages.yaml: '{name}' and '{homes[home]}' share {cloud} {key} '{home}'; "
                                     f"each stage needs its own")
                homes[home] = name
        seen: dict[str, str] = {}
        for s in self.stages.values():
            for p in s.environments:
                if p in seen:
                    raise ValueError(f"stages.yaml: environment pattern '{p}' is used by both '{seen[p]}' and '{s.name}'")
                seen[p] = s.name
        names: set[str] = set()
        previews: dict[str, int] = {}
        team_stages = {t.name: t.stages for t in self.teams}
        for c in self.clusters:
            where = f"teams/{c.team}/clusters.yaml: '{c.name}'"
            if c.name in names:
                raise ValueError(f"{where} is defined twice")
            names.add(c.name)
            if not c.name.startswith(f"{c.team}-"):
                raise ValueError(f"{where} must start with '{c.team}-' (cluster names are global)")
            if c.stage not in self.stages:
                raise ValueError(f"{where} uses unknown stage '{c.stage}'")
            if c.stage not in team_stages[c.team]:
                raise ValueError(f"{where} is in stage '{c.stage}', which access.yaml doesn't enable")
            if c.provider == "gke" and not c.gcpProject:
                raise ValueError(f"{where} (GKE) needs gcpProject")
            if c.provider == "eks" and not c.oidcIssuer:
                raise ValueError(f"{where} (EKS) needs oidcIssuer")
            if c.provider == "eks" and len(c.name) > 32:  # it becomes a GCP workload identity provider id
                raise ValueError(f"{where} (EKS) name must be <= 32 characters")
            if self.stages[c.stage].preview:
                previews[c.team] = previews.get(c.team, 0) + 1
                if previews[c.team] > 1:
                    raise ValueError(f"teams/{c.team}/clusters.yaml: at most one cluster in the preview stage")

    def _validate_teams(self) -> None:
        limit = self.conventions.max_team_name()
        namespaces: dict[str, str] = {}
        patterns: dict[str, str] = {}
        for t in self.teams:
            for pat in t.projects:
                if pat in patterns:
                    raise ValueError(f"team '{t.name}': project pattern '{pat}' is already claimed by '{patterns[pat]}'")
                patterns[pat] = t.name
            if not DNS_LABEL.match(t.name) or len(t.name) > limit:
                raise ValueError(f"team '{t.name}': folder name must be a DNS label of <= {limit} characters")
            if t.namespace in namespaces:
                raise ValueError(f"team '{t.name}': namespace '{t.namespace}' is already used by '{namespaces[t.namespace]}'")
            namespaces[t.namespace] = t.name
            if t.pod_security not in ("restricted", "baseline"):
                raise ValueError(f"team '{t.name}': podSecurity must be restricted or baseline")
            if t.secrets_provider not in ("gcp", "aws"):
                raise ValueError(f"team '{t.name}': secrets.provider must be gcp or aws")
            undeclared = set(t.stages) - set(self.stages)
            if undeclared:
                raise ValueError(f"team '{t.name}': unknown stages {sorted(undeclared)}")

    @classmethod
    def load(cls, root: Path, schemas_dir: Path | None = None) -> "Platform":
        return cls(load_platform_dir(root, schemas_dir))

    def describe(self) -> dict:
        """Read-only view for UIs (no secrets, no identities beyond names)."""
        return {
            "stages": [{"name": s.name, "gitlabTier": s.gitlab_tier, "environments": list(s.environments),
                        "preview": s.preview, "partialTargets": s.partial_targets, "allowStop": s.allow_stop,
                        "autoApply": s.auto_apply,
                        **({"secrets": {"gcpProject": ss.gcp_project, "awsAccount": ss.aws_account,
                                        "awsRegion": ss.aws_region}}
                           if (ss := self.stage_secrets.get(s.name)) else {})}
                       for s in self.stages.values()],
            "teams": [{"name": t.name, "namespace": t.namespace, "group": t.group or None, "owners": list(t.owners),
                       "projects": list(t.projects), "stages": t.stages, "domains": list(t.domains),
                       "podSecurity": t.pod_security, "secretsProvider": t.secrets_provider,
                       "secretWriters": t.secrets.get("writers") or {},
                       "preview": t.preview,
                       "clusters": [{"name": c.name, "stage": c.stage, "provider": c.provider, "region": c.region,
                                     "domain": c.domain, "previewDomain": c.previewDomain,
                                     "hasGateway": bool(c.gateway), "features": list(c.features)}
                                    for c in self.clusters if c.team == t.name]}
                      for t in self.teams],
            "registry": {"server": self.registry.get("server")} if self.registry else None,
            "conventions": {"secretKeySeparator": self.conventions.secretKeySeparator,
                            "previewNamespaceSuffix": self.conventions.previewNamespaceSuffix,
                            "platformSecretsApp": self.conventions.platformSecretsApp},
        }

    # --- lookups -------------------------------------------------------------
    def stage_for(self, env_name: str) -> tuple[Stage, str] | None:
        """First stage (in stages.yaml order) whose environment globs match."""
        for s in self.stages.values():
            if (pat := s.match(env_name)):
                return s, pat
        return None

    def preview_namespace(self, team: Team) -> str:
        return f"{team.namespace}{self.conventions.previewNamespaceSuffix}"

    def namespace(self, team: Team, stage: str) -> str:
        return self.preview_namespace(team) if stage == self.preview_stage else team.namespace

    def team(self, name: str) -> Team:
        for t in self.teams:
            if t.name == name:
                return t
        raise PolicyError(f"unknown team '{name}'")

    def team_for(self, project_path: str) -> Team:
        matches = [t for t in self.teams if any(fnmatch(project_path, pat) for pat in t.projects)]
        if len(matches) > 1:
            raise PolicyError(f"project '{project_path}' matches several teams "
                              f"({', '.join(t.name for t in matches)}); fix their `projects` in access.yaml")
        if not matches:
            raise PolicyError(f"project '{project_path}' is not onboarded to any team")
        return matches[0]

    # --- authorization -------------------------------------------------------
    def resolve_env(self, env_name: str, tier: str | None) -> EnvRef:
        found = self.stage_for(env_name)
        if not found:
            routes = ", ".join(f"{p} -> {s.name}" for s in self.stages.values() for p in s.environments)
            raise PolicyError(f"environment '{env_name}' doesn't map to any stage ({routes})")
        stage, pattern = found
        if tier != stage.gitlab_tier:
            raise PolicyError(f"environment '{env_name}' is stage '{stage.name}', whose jobs must declare "
                              f"deployment_tier '{stage.gitlab_tier}' (got {tier!r})")
        return EnvRef(env_name, stage.name, tier, stage.preview,
                      preview_slug(env_name, pattern) if stage.preview else None)

    def authorize(self, claims: dict, env_name: str) -> tuple[Team, EnvRef]:
        # The token's own environment claim must match; otherwise a job could claim
        # 'production' while running as some other job/environment.
        if claims.get("environment") != env_name:
            raise PolicyError(f"token was issued for environment '{claims.get('environment')}', "
                              f"not '{env_name}' (set `environment:` on the CI job)")
        env = self.resolve_env(env_name, claims.get("deployment_tier"))
        team = self.team_for(claims.get("project_path", ""))
        rules = team.stages.get(env.stage)
        if rules is None:
            raise PolicyError(f"team '{team.name}' may not deploy to stage '{env.stage}'")
        if rules.get("protectedRefOnly") and str(claims.get("ref_protected")) != "true":
            raise PolicyError(f"stage '{env.stage}' deploys must come from a protected branch or tag")
        if rules.get("requireProtectedEnvironment") and str(claims.get("environment_protected")) != "true":
            raise PolicyError(f"'{env_name}' must be a protected environment in GitLab "
                              f"(protect the '{env.tier}' tier at group level, or the environment in the project)")
        return team, env

    def team_clusters(self, team: Team, stage: str) -> list[Cluster]:
        return [c for c in self.clusters if c.team == team.name and c.stage == stage]

    def hosts_for(self, team: Team, cluster: Cluster, app: str, deployed_name: str, preview: bool,
                  ingress: dict | None, has_port: bool = True) -> list[str]:
        """Public hostnames for one app on one cluster ([] = not exposed)."""
        if not has_port:
            return []  # workers and scheduled jobs have nothing to route to
        if preview:
            return [f"{deployed_name}.{cluster.previewDomain}"] if cluster.previewDomain and cluster.gateway else []
        if ingress is None:
            return []
        if not cluster.gateway:
            raise PolicyError(f"cluster '{cluster.name}' has no gateway; ingress isn't available there")
        hosts = ingress.get("hosts") or []
        if not hosts:
            if not cluster.domain:
                raise PolicyError(f"cluster '{cluster.name}' has no domain; set ingress.hosts explicitly")
            return [f"{app}.{cluster.domain}"]
        bad = [h for h in hosts if not any(fnmatch(h, d) for d in team.domains)]
        if bad:
            raise PolicyError(f"hosts {bad} aren't in team '{team.name}' domains {list(team.domains)} (access.yaml)")
        return hosts

    def preview_cluster(self, team: Team) -> Cluster | None:
        found = self.team_clusters(team, self.preview_stage) if self.preview_stage else []
        return found[0] if found else None

    def resolve(self, team: Team, env: EnvRef, targets: list[dict]) -> tuple[list[Cluster], list[str]]:
        """The team's own clusters for this deploy, and targets skipped (partialTargets stages only)."""
        if env.is_preview:
            pc = self.preview_cluster(team)
            if not pc:
                raise PolicyError(f"team '{team.name}' has no cluster in the preview stage "
                                  f"(teams/{team.name}/clusters.yaml)")
            return [pc], []  # previews ignore targets: one cheap cluster
        mine = self.team_clusters(team, env.stage)
        out, missing = [], []
        for t in targets:
            match = [c for c in mine if c.provider == t["provider"] and c.region == t["region"]]
            if match:
                out.append(match[0])
            else:
                missing.append(f"{t['provider']}/{t['region']}")
        if missing and out and self.stages[env.stage].partial_targets:
            return out, missing
        if missing:
            available = sorted(f"{c.provider}/{c.region}" for c in mine)
            raise PolicyError(f"team '{team.name}' has no '{env.stage}' cluster for {', '.join(missing)}; "
                              f"available: {', '.join(available) or 'none'} (teams/{team.name}/clusters.yaml)")
        return out, []


class PlatformHolder:
    """The current Platform, reloaded when files under the platform folder change.

    Run DAAS with the platform repo mounted through git-sync (or any synced checkout): merged
    changes to stages, teams and clusters take effect without redeploying DAAS. An invalid change
    is logged and ignored; the last good config stays active.
    """

    def __init__(self, root: Path, interval_seconds: int = 30, on_reload=None, schemas_dir: Path | None = None):
        import logging
        import time
        self._log = logging.getLogger("daas.platform")
        self._time = time.monotonic
        self.root, self.interval, self.on_reload, self.schemas_dir = root, interval_seconds, on_reload, schemas_dir
        self.current = Platform.load(root, schemas_dir)
        self._fingerprint = self._fp()
        self._checked = self._time()
        self.last_error: str | None = None

    def _fp(self) -> tuple:
        return tuple(sorted((str(p), p.stat().st_mtime_ns, p.stat().st_size)
                            for p in self.root.rglob("*.yaml")))

    def get(self) -> "Platform":
        if self.interval and self._time() - self._checked >= self.interval:
            self._checked = self._time()
            self.reload_if_changed()
        return self.current

    def reload_if_changed(self) -> bool:
        fp = self._fp()
        if fp == self._fingerprint:
            return False
        self._fingerprint = fp
        try:
            new = Platform.load(self.root, self.schemas_dir)
            # These rename cloud resources and repos; changing them live would split old and new names.
            if new.conventions != self.current.conventions or new.gitops_repo != self.current.gitops_repo:
                raise ValueError("conventions.yaml / gitopsRepo changed: restart DAAS to apply")
        except Exception as e:  # noqa: BLE001 — any bad config must leave the last good one active
            self.last_error = f"{type(e).__name__}: {e}"
            self._log.error("platform config change rejected, keeping the previous one: %s", self.last_error)
            return False
        self.current, self.last_error = new, None
        self._log.info("platform config reloaded")
        if self.on_reload:
            try:
                self.on_reload(new)
            except Exception as e:  # noqa: BLE001 — a failed re-render must not fail the request that noticed
                self.last_error = f"config loaded, but re-rendering platform objects failed: {e}"
                self._log.error(self.last_error)
        return True
