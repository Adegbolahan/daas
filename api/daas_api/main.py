import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import platform_render, reaper, rollout
from .auth import make_claims_dependency
from .config import Settings
from .entra import make_user_dependency
from .gitops import GitOpsRepo
from .health import ArgoCDChecker, CommitOnlyChecker
from .notify import ArgoWebhook, Notifier
from .policy import EnvRef, Platform, PlatformHolder, PolicyError, Team, infer_tier, preview_slug
from .render import Placement, render, resolve_secrets, to_yaml
from .secrets_backend import CloudBackend, MemoryBackend, SecretsBackend
from .spec import AppSpec, SpecError, load_schema, parse
from .store import Store

log = logging.getLogger("daas")
audit = logging.getLogger("daas.audit")
if not audit.handlers:  # JSON lines on stdout; ship them to your log pipeline
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(message)s"))
    audit.addHandler(_h)
    audit.setLevel(logging.INFO)
    audit.propagate = False
DNS_LABEL = re.compile(r"^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$")
SECRET_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")
REGISTRY_SECRET = "REGISTRY_AUTH"


class DeployRequest(BaseModel):
    spec: str = Field(description="Raw daas.yaml contents")
    image: str = Field(min_length=1, description="Image built in CI (used unless daas.yaml sets image)")
    environment: str = Field(min_length=1, description="GitLab environment name, e.g. production or review/mr-42. "
                                                      "It maps to a stage; its GitLab tier comes from the token.")
    dryRun: bool = False


class PreviewRequest(BaseModel):
    spec: str = Field(description="Raw daas.yaml contents")
    team: str
    environment: str = Field(min_length=1, description="GitLab environment name, e.g. production or review/mr-1")
    image: str = "registry.example.com/preview:latest"


class SecretWrite(BaseModel):
    value: str = Field(min_length=1, max_length=65536)
    provider: Literal["gcp", "aws"] | None = Field(None, description="Defaults to the team's provider")


def _deployed_name(app: str, env: EnvRef) -> str:
    return f"{app}-{env.slug}" if env.is_preview else app


def check_settings(s: Settings) -> None:
    """Refuse unsafe combinations at startup rather than discovering them in production."""
    if s.auth_mode not in ("gitlab", "dev"):
        raise RuntimeError(f"DAAS_AUTH_MODE must be gitlab or dev, not {s.auth_mode!r}")
    if s.auth_mode == "dev" and s.gitops_push:
        raise RuntimeError("DAAS_AUTH_MODE=dev trusts request headers; it can't be combined with DAAS_GITOPS_PUSH=true")
    if s.auth_mode == "dev" and s.secrets_backend != "memory":
        raise RuntimeError("DAAS_AUTH_MODE=dev can only use DAAS_SECRETS_BACKEND=memory")
    if s.auth_mode != "dev" and not s.state_db:
        raise RuntimeError("DAAS_STATE_DB is required outside dev mode (a SQLite file on a volume), "
                           "or deployment records are lost on restart")
    if s.auth_mode != "dev" and not s.argocd_url and not s.allow_unverified_health:
        raise RuntimeError("DAAS_ARGOCD_URL is required: without it, deploys 'succeed' without any health check "
                           "(set DAAS_ALLOW_UNVERIFIED_HEALTH=true to accept that)")


def create_app(settings: Settings | None = None, checker=None, repo: GitOpsRepo | None = None,
               secrets: SecretsBackend | None = None, notifier: Notifier | None = None) -> FastAPI:
    s = settings or Settings()
    check_settings(s)
    schemas_dir = s.schema_file.parent
    first = Platform.load(s.platform_dir, schemas_dir)
    repo = repo or GitOpsRepo(s.gitops_path, push=s.gitops_push, remote=first.gitops_repo, token=s.gitops_token)

    def on_reload(p: Platform) -> None:
        if s.sync_platform_on_start:
            platform_render.sync(p, repo)

    holder = PlatformHolder(s.platform_dir, s.platform_reload_seconds, on_reload, schemas_dir)
    conv = first.conventions  # naming conventions are fixed for the process (they rename cloud resources)
    secrets = secrets or (MemoryBackend() if s.secrets_backend == "memory" else CloudBackend(conv))
    notifier = notifier or Notifier()
    argo_hook = ArgoWebhook(first.gitops_repo)
    user_dep = make_user_dependency(s)
    schema = load_schema(s.schema_file)
    store = Store(s.state_db)
    for rid in store.interrupt_unfinished():
        log.warning("deployment %s was interrupted by a restart and marked failed", rid)
    checker = checker or (ArgoCDChecker(s.argocd_url, s.argocd_token, contains=repo.contains)
                          if s.argocd_url else CommitOnlyChecker())

    def _dev_tier(env_name: str) -> str:
        found = holder.get().stage_for(env_name)
        return found[0].gitlab_tier if found else infer_tier(env_name)

    claims_dep = make_claims_dependency(s, _dev_tier)

    if s.sync_platform_on_start:
        platform_render.sync(first, repo)
    if s.reaper_interval_seconds > 0:
        reaper.start(repo, s.reaper_interval_seconds)

    app = FastAPI(title="DAAS", version="0.3.0")

    def authorize(platform: Platform, claims: dict, environment: str) -> tuple[Team, EnvRef]:
        try:
            return platform.authorize(claims, environment)
        except PolicyError as e:
            raise HTTPException(403, {"errors": [str(e)]})

    def check_owner(app_dir: str, project: str) -> dict | None:
        meta = repo.read_meta(app_dir)
        if meta and meta.get("project") != project:
            raise HTTPException(409, {"errors": [f"'{app_dir}' is owned by project '{meta.get('project')}'"]})
        return meta

    def plan_placements(platform: Platform, team: Team, env: EnvRef, spec: AppSpec):
        """Where the app lands for this environment: (name, namespace, placements, skipped, warnings)."""
        try:
            clusters, skipped = platform.resolve(team, env, spec.targets)
        except PolicyError as e:
            raise HTTPException(403, {"errors": [str(e)]})
        name = _deployed_name(spec.name, env)
        if len(name) > 63:
            raise HTTPException(422, {"errors": [f"deployed name '{name}' exceeds 63 characters; shorten `name`"]})
        namespace = platform.namespace(team, env.stage)
        pull_secret = conv.registryPullSecret if platform.registry else None
        placements, warnings = [], []
        for c in clusters:
            try:
                hosts = platform.hosts_for(team, c, spec.name, name, env.is_preview, spec.ingress, bool(spec.port))
            except PolicyError as e:
                # lenient stages (partialTargets) deploy cluster-internal; strict ones (production) refuse
                if not platform.stages[env.stage].partial_targets:
                    raise HTTPException(403, {"errors": [str(e)]})
                warnings.append(f"{e}; deployed without a public route")
                hosts = []
            placements.append(Placement(c, namespace, name, team.name, env.is_preview, tuple(hosts),
                                        team.pod_security, pull_secret, (spec.ingress or {}).get("path", "/")))
        return name, namespace, placements, skipped, warnings

    @app.get("/healthz")
    def healthz():
        return {"ok": True, "platformConfigError": holder.last_error}

    @app.post("/v1/deployments", status_code=202)
    def create_deployment(req: DeployRequest, bg: BackgroundTasks, claims: dict = Depends(claims_dep)):
        platform = holder.get()
        try:
            base: AppSpec = parse(req.spec, schema)
        except SpecError as e:
            raise HTTPException(422, {"errors": e.errors})
        if base.name == conv.platformSecretsApp:
            raise HTTPException(422, {"errors": [f"app name '{base.name}' is reserved for the platform"]})
        team, env = authorize(platform, claims, req.environment)
        unknown = set(base.stage_overrides) - set(platform.stages)
        if unknown:
            raise HTTPException(422, {"errors": [f"daas.yaml stages: unknown stages {sorted(unknown)}"]})
        spec = base.for_stage(env.stage)
        name, namespace, placements, skipped, warnings = plan_placements(platform, team, env, spec)
        project = claims.get("project_path", "")

        # Secrets: every value (and the team's registry credentials) must exist in this stage,
        # so the rollout doesn't stall on an ExternalSecret or image pull that can never succeed.
        resolved = resolve_secrets(spec, team.secrets_provider)
        needed = [(n, prov, conv.remote_key(team.name, spec.name, n)) for n, prov in resolved]
        if platform.registry:
            needed.append((f"{REGISTRY_SECRET} (registry)", platform.registry.get("provider", team.secrets_provider),
                           conv.remote_key(team.name, conv.platformSecretsApp, REGISTRY_SECRET)))
        if needed:
            ss = platform.stage_secrets.get(env.stage)
            if not ss:
                raise HTTPException(422, {"errors": [f"no secrets project/account configured for stage '{env.stage}'"]})
            if s.check_secrets:
                missing = [f"{n} ({prov})" for n, prov, key in needed if not secrets.exists(ss, prov, key)]
                if missing:
                    raise HTTPException(422, {"errors": [
                        f"secrets not set for stage '{env.stage}': {', '.join(missing)}. Set them with "
                        f"PUT /v1/secrets/{env.stage}/{team.name}/<app>/<NAME>"]})

        # Ownership: an app name belongs to the project that first deployed it, and a cluster slot
        # belongs to one environment (production and production-eu can't both claim the same cluster).
        new_dirs = []
        for p in placements:
            d = GitOpsRepo.app_dir(p.cluster.name, namespace, name)
            meta = check_owner(d, project)
            if meta is None:
                new_dirs.append(d)
            elif meta.get("environment") != req.environment:
                raise HTTPException(409, {"errors": [
                    f"'{d}' is already deployed by environment '{meta.get('environment')}'"]})

        if env.is_preview and new_dirs:
            limit = team.preview.get("maxConcurrent", 5)
            active = [m for _, m in repo.all_meta() if m.get("preview") and m.get("team") == team.name]
            if len(active) >= limit:
                raise HTTPException(403, {"errors": [
                    f"team '{team.name}' already has {len(active)} previews (max {limit}); stop one first"]})

        expires = (datetime.now(timezone.utc) + timedelta(hours=s.preview_ttl_hours)).isoformat() \
            if env.is_preview else None
        waves = rollout.plan_waves(placements, spec.strategy)
        record = store.create({
            "status": "pending", "app": spec.name, "kind": spec.kind, "name": name, "namespace": namespace,
            "team": team.name, "environment": req.environment, "stage": env.stage, "tier": env.tier,
            "image": spec.image or req.image, "dryRun": req.dryRun, "spec": req.spec,
            "requestedBy": {k: claims.get(k) for k in ("project_path", "ref", "sha", "user_login", "pipeline_id")},
            "clusters": [{"cluster": p.cluster.name, "wave": i, "status": "pending"}
                         for i, w in enumerate(waves, 1) for p in w],
            **({"expiresAt": expires} if expires else {}),
            **({"skippedTargets": skipped} if skipped else {}),
        })

        files: dict[str, dict[str, str]] = {}
        manifests: dict[str, str] = {}
        for p in placements:
            d = GitOpsRepo.app_dir(p.cluster.name, namespace, name)
            manifests[p.cluster.name] = to_yaml(render(spec, req.image, p, record["id"], resolved, conv))
            meta = {"team": team.name, "project": project, "app": spec.name, "kind": spec.kind, "name": name,
                    "namespace": namespace, "cluster": p.cluster.name, "environment": req.environment,
                    "stage": env.stage, "tier": env.tier, "preview": env.is_preview, "expiresAt": expires,
                    "deploymentId": record["id"], "image": spec.image or req.image, "hosts": list(p.hosts)}
            files[p.cluster.name] = {f"{d}/manifests.yaml": manifests[p.cluster.name],
                                     f"{d}/daas.json": json.dumps(meta, indent=2) + "\n"}

        urls = sorted({f"https://{h}{(spec.ingress or {}).get('path', '/').rstrip('/')}"
                       for p in placements for h in p.hosts})
        plan = [{"cluster": p.cluster.name, "wave": i, **({"hosts": list(p.hosts)} if p.hosts else {}),
                 **({"manifests": manifests[p.cluster.name]} if req.dryRun else {})}
                for i, w in enumerate(waves, 1) for p in w]

        if req.dryRun:
            store.update(record["id"], status="succeeded", message="dry run")
        else:
            bg.add_task(rollout.execute, record["id"], waves, files, f"{namespace}/{name}",
                        repo, checker, store, s.wave_timeout_seconds,
                        on_commit=argo_hook.pushed,
                        on_done=lambda rec, env_var=team.notify_env: notifier.deployment_finished(rec, env_var))
        return {"id": record["id"], "status": "succeeded" if req.dryRun else "pending", "plan": plan,
                **({"url": urls[0], "urls": urls} if urls else {}),
                **({"skippedTargets": skipped} if skipped else {}),
                **({"warnings": warnings} if warnings else {}),
                **({"expiresAt": expires} if expires else {})}

    @app.get("/v1/deployments/{rid}")
    def get_deployment(rid: str, claims: dict = Depends(claims_dep)):
        rec = store.get(rid)
        if not rec or rec["requestedBy"]["project_path"] != claims.get("project_path"):
            raise HTTPException(404, "not found")
        return rec

    @app.delete("/v1/environments/{environment:path}")
    def delete_environment(environment: str, app: str | None = None, claims: dict = Depends(claims_dep)):
        """Remove the calling project's apps from an environment (all clusters). Used by GitLab stop jobs.

        Only for previews, or stages with `allowStop: true`, so "Stop environment" on production
        can't delete production. ?app=<name> limits it to one app.
        """
        platform = holder.get()
        _, env = authorize(platform, claims, environment)
        if not platform.stages[env.stage].allow_stop:
            raise HTTPException(403, {"errors": [
                f"stage '{env.stage}' doesn't allow stopping environments through DAAS (allowStop in stages.yaml)"]})
        project = claims.get("project_path", "")
        dirs = [d for d, m in repo.all_meta()
                if m.get("environment") == environment and m.get("project") == project
                and (app is None or m.get("app") == app)]
        if not dirs:
            raise HTTPException(404, f"nothing owned by '{project}' is deployed in '{environment}'")
        sha = repo.remove(dirs, f"delete {project} from {environment}")
        argo_hook.pushed(sha, dirs)
        audit.info(json.dumps({"action": "environment.stop", "project": project, "environment": environment,
                               "removed": dirs}))
        return {"removed": dirs, "revision": sha}

    # ---------------- read API for UIs such as Backstage (Entra ID: any signed-in user or app) -------------

    @app.get("/v1/schemas")
    def get_schemas(user: dict = Depends(user_dep)):
        """JSON Schemas for an app's daas.yaml and a team's platform files (UIs generate forms from them)."""
        def load(n):
            return json.loads((schemas_dir / n).read_text())
        return {"app": schema, "teamAccess": load("team-access.schema.json"),
                "teamClusters": load("team-clusters.schema.json"), "teamSecrets": load("team-secrets.schema.json")}

    @app.get("/v1/platform")
    def get_platform(user: dict = Depends(user_dep)):
        """Stages, teams and their clusters (read-only; no secret values or credentials)."""
        return {**holder.get().describe(), "configError": holder.last_error}

    @app.get("/v1/apps")
    def list_apps(team: str | None = None, user: dict = Depends(user_dep)):
        """What's deployed where, from the GitOps repo: one entry per (team, app)."""
        apps: dict[tuple, dict] = {}
        for _, m in repo.all_meta():
            if team and m.get("team") != team:
                continue
            a = apps.setdefault((m.get("team"), m.get("app")), {
                "team": m.get("team"), "app": m.get("app"), "project": m.get("project"), "kind": m.get("kind"),
                "environments": {}})
            e = a["environments"].setdefault(m.get("environment"), {
                "environment": m.get("environment"), "stage": m.get("stage"), "tier": m.get("tier"),
                "name": m.get("name"), "namespace": m.get("namespace"), "preview": m.get("preview", False),
                "expiresAt": m.get("expiresAt"), "image": m.get("image"), "deploymentId": m.get("deploymentId"),
                "clusters": []})
            e["clusters"].append({"cluster": m.get("cluster"), "hosts": m.get("hosts") or []})
        return {"apps": [{**a, "environments": sorted(a["environments"].values(), key=lambda e: e["environment"])}
                         for a in sorted(apps.values(), key=lambda a: (a["team"] or "", a["app"] or ""))]}

    @app.get("/v1/deployments")
    def list_deployments(team: str | None = None, app: str | None = None, environment: str | None = None,
                         limit: int = 50, user: dict = Depends(user_dep)):
        """Deployment history, newest first (records without the daas.yaml body)."""
        rows = store.find(team=team, app=app, environment=environment)[:max(1, min(limit, 500))]
        return {"deployments": [{k: v for k, v in r.items() if k != "spec"} for r in rows]}

    @app.get("/v1/apps/{team_name}/{app_name}/spec")
    def get_app_spec(team_name: str, app_name: str, environment: str | None = None,
                     user: dict = Depends(user_dep)):
        """The daas.yaml of the latest deployment (used to pre-fill 'update app' forms)."""
        for r in store.find(team=team_name, app=app_name, environment=environment):
            if r.get("spec"):
                return {"spec": r["spec"], "deploymentId": r["id"], "environment": r.get("environment"),
                        "project": (r.get("requestedBy") or {}).get("project_path")}
        raise HTTPException(404, f"no deployment of {team_name}/{app_name} recorded yet")

    @app.post("/v1/preview")
    def preview(req: PreviewRequest, user: dict = Depends(user_dep)):
        """Validate a daas.yaml for a team and environment and show where it would land. Never deploys.

        Always 200: {valid, errors[], warnings[], skippedTargets[], missingSecrets[], plan[], manifests{}}.
        """
        platform = holder.get()
        out = {"valid": False, "errors": [], "warnings": [], "skippedTargets": [], "missingSecrets": [],
               "plan": [], "manifests": {}}
        try:
            base = parse(req.spec, schema)
            team = platform.team(req.team)
            found = platform.stage_for(req.environment)
            if not found:
                raise PolicyError(f"environment '{req.environment}' doesn't map to any stage")
            stage, pattern = found
            env = EnvRef(req.environment, stage.name, stage.gitlab_tier, stage.preview,
                         preview_slug(req.environment, pattern) if stage.preview else None)
            if env.stage not in team.stages:
                raise PolicyError(f"team '{team.name}' may not deploy to stage '{env.stage}'")
            unknown = set(base.stage_overrides) - set(platform.stages)
            if unknown:
                raise PolicyError(f"daas.yaml stages: unknown stages {sorted(unknown)}")
            if base.name == conv.platformSecretsApp:
                raise PolicyError(f"app name '{base.name}' is reserved for the platform")
            spec = base.for_stage(env.stage)
            name, namespace, placements, skipped, warnings = plan_placements(platform, team, env, spec)
        except SpecError as e:
            out["errors"] = e.errors
            return out
        except PolicyError as e:
            out["errors"] = [str(e)]
            return out
        except HTTPException as e:
            out["errors"] = (e.detail or {}).get("errors", [str(e.detail)]) if isinstance(e.detail, dict) \
                else [str(e.detail)]
            return out
        resolved = resolve_secrets(spec, team.secrets_provider)
        ss = platform.stage_secrets.get(env.stage)
        if ss and s.check_secrets:
            out["missingSecrets"] = [{"name": n, "provider": prov} for n, prov in resolved
                                     if not secrets.exists(ss, prov, conv.remote_key(team.name, spec.name, n))]
        waves = rollout.plan_waves(placements, spec.strategy)
        out.update(valid=True, warnings=warnings, skippedTargets=skipped, kind=spec.kind, name=name,
                   namespace=namespace, stage=env.stage,
                   plan=[{"cluster": p.cluster.name, "provider": p.cluster.provider, "region": p.cluster.region,
                          "wave": i, "hosts": list(p.hosts)} for i, w in enumerate(waves, 1) for p in w],
                   manifests={p.cluster.name: to_yaml(render(spec, req.image, p, "preview", resolved, conv))
                              for p in placements})
        return out

    # ---------------- secrets (humans, Entra ID) ----------------

    def secret_scope(user: dict, stage: str, team_name: str, app_name: str):
        platform = holder.get()
        try:
            team = platform.team(team_name)
        except PolicyError as e:
            raise HTTPException(404, str(e))
        if stage not in team.stages or stage not in platform.stage_secrets:
            raise HTTPException(404, f"team '{team.name}' has no stage '{stage}' with secrets")
        if not DNS_LABEL.match(app_name):
            raise HTTPException(422, "app must be a DNS label (the `name` in daas.yaml)")
        role = team.secret_writer(stage)
        if not role or role not in user["roles"]:
            raise HTTPException(403, f"needs Entra role/group '{role}' to manage {team.name} secrets in {stage}")
        return team, platform.stage_secrets[stage]

    @app.put("/v1/secrets/{stage}/{team_name}/{app_name}/{name}")
    def put_secret(stage: str, team_name: str, app_name: str, name: str, body: SecretWrite,
                   user: dict = Depends(user_dep)):
        """Create or update a secret value. Write-only: values are never returned."""
        team, ts = secret_scope(user, stage, team_name, app_name)
        if not SECRET_NAME.match(name):
            raise HTTPException(422, "secret name must match ^[A-Z][A-Z0-9_]*$")
        if app_name == conv.platformSecretsApp and name == REGISTRY_SECRET:
            try:
                json.loads(body.value)["auths"]
            except (ValueError, KeyError, TypeError):
                raise HTTPException(422, "REGISTRY_AUTH must be a Docker config JSON ({\"auths\": {...}})")
        provider = body.provider or (holder.get().registry.get("provider") if app_name == conv.platformSecretsApp
                                     and holder.get().registry else None) or team.secrets_provider
        key = conv.remote_key(team.name, app_name, name)
        secrets.put(ts, provider, key, body.value, {"team": team.name, "app": app_name})
        audit.info(json.dumps({"action": "secret.put", "user": user["user"], "stage": stage,
                               "provider": provider, "key": key}))
        return {"key": key, "provider": provider, "stage": stage}

    @app.get("/v1/secrets/{stage}/{team_name}/{app_name}")
    def list_secrets(stage: str, team_name: str, app_name: str, user: dict = Depends(user_dep)):
        """Names and last-updated times in both providers. No values."""
        team, ts = secret_scope(user, stage, team_name, app_name)
        prefix = conv.remote_key(team.name, app_name, "")
        return {"stage": stage, "secrets": [
            {"name": x["key"][len(prefix):], "provider": prov, "key": x["key"], "updated": x["updated"]}
            for prov in ("gcp", "aws") for x in secrets.list(ts, prov, prefix)]}

    @app.delete("/v1/secrets/{stage}/{team_name}/{app_name}/{name}")
    def delete_secret(stage: str, team_name: str, app_name: str, name: str,
                      provider: Literal["gcp", "aws"] | None = None, user: dict = Depends(user_dep)):
        team, ts = secret_scope(user, stage, team_name, app_name)
        provider = provider or team.secrets_provider
        key = conv.remote_key(team.name, app_name, name)
        if not secrets.delete(ts, provider, key):
            raise HTTPException(404, f"{key} not found in {provider}")
        audit.info(json.dumps({"action": "secret.delete", "user": user["user"], "stage": stage,
                               "provider": provider, "key": key}))
        return {"deleted": key, "provider": provider}

    return app
