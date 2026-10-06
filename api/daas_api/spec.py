"""Parse and validate an app's daas.yaml."""
import copy
import json
from dataclasses import dataclass, field, replace
from pathlib import Path

import jsonschema
import yaml

MERGE_KEYS = ("env", "scaling", "resources")          # stage overrides merge over the base
REPLACE_KEYS = ("identity", "ingress", "targets")     # stage overrides replace the base


class SpecError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


@dataclass
class AppSpec:
    name: str
    targets: list[dict]
    port: int | None = None
    schedule: str | None = None
    image: str | None = None
    command: list[str] = field(default_factory=list)
    args: list[str] = field(default_factory=list)
    env: dict = field(default_factory=dict)
    resources: dict = field(default_factory=dict)
    health: dict = field(default_factory=dict)
    scaling: dict = field(default_factory=dict)
    secrets: list[dict] = field(default_factory=list)  # [{"name": "DB_URL", "from": "gcp" | "aws" | None}]
    identity: dict = field(default_factory=dict)
    ingress: dict | None = None
    metrics: dict | None = None
    strategy: str = "sequential"
    stage_overrides: dict = field(default_factory=dict)

    @property
    def kind(self) -> str:
        """service (has a port), worker (no port) or cronjob (schedule)."""
        return "cronjob" if self.schedule else ("service" if self.port else "worker")

    def for_stage(self, stage: str) -> "AppSpec":
        """This spec with the stage's overrides applied."""
        o = self.stage_overrides.get(stage) or {}
        if not o:
            return self
        s = replace(self, **{k: copy.deepcopy(getattr(self, k)) for k in MERGE_KEYS})
        for k in MERGE_KEYS:
            if k in o:
                getattr(s, k).update(o[k])
        for k in REPLACE_KEYS:
            if k in o:
                setattr(s, k, copy.deepcopy(o[k]))
        if "ingress" in o and o["ingress"] is not None:
            s.ingress = {"path": "/", **o["ingress"]}
        _check(s, f"daas.yaml stages.{stage}")
        return s


def load_schema(path: Path) -> dict:
    return json.loads(path.read_text())


def _check(s: AppSpec, where: str = "daas.yaml") -> None:
    errs = []
    if s.scaling["max"] < s.scaling["min"]:
        errs.append(f"{where}: scaling.max must be >= scaling.min")
    keys = [(t["provider"], t["region"]) for t in s.targets]
    if len(keys) != len(set(keys)):
        errs.append(f"{where}: duplicate target in targets")
    if s.schedule and (s.port or s.health or s.ingress):
        errs.append(f"{where}: a scheduled job can't have port, health or ingress")
    if not s.port and s.health:
        errs.append(f"{where}: health checks need a port")
    if not s.port and s.ingress is not None:
        errs.append(f"{where}: ingress needs a port")
    if s.metrics is not None and not (s.metrics.get("port") or s.port):
        errs.append(f"{where}: metrics needs a port (metrics.port or port)")
    if errs:
        raise SpecError(errs)


def parse(text: str, schema: dict) -> AppSpec:
    try:
        d = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise SpecError([f"daas.yaml: invalid YAML: {e}"])
    if not isinstance(d, dict):
        raise SpecError(["daas.yaml: expected a mapping at the top level"])

    v = jsonschema.Draft202012Validator(schema)
    errs = [f"daas.yaml: {'/'.join(map(str, e.path)) or '(root)'}: {e.message}"
            for e in sorted(v.iter_errors(d), key=lambda e: list(e.path))]
    if errs:
        raise SpecError(errs)

    secrets = [{"name": x, "from": None} if isinstance(x, str) else {"name": x["name"], "from": x.get("from")}
               for x in d.get("secrets") or []]
    names = [x["name"] for x in secrets]
    if len(names) != len(set(names)):
        raise SpecError(["daas.yaml: duplicate secret name"])
    env_keys = set(d.get("env") or {}) | {k for o in (d.get("stages") or {}).values() for k in (o.get("env") or {})}
    overlap = set(names) & env_keys
    if overlap:
        raise SpecError([f"daas.yaml: {', '.join(sorted(overlap))} set in both env and secrets"])

    ingress = d.get("ingress")
    spec = AppSpec(
        name=d["name"],
        targets=d["targets"],
        port=d.get("port"),
        schedule=d.get("schedule"),
        image=d.get("image"),
        command=d.get("command") or [],
        args=d.get("args") or [],
        env=d.get("env") or {},
        resources={"cpu": "250m", "memory": "256Mi", **(d.get("resources") or {})},
        health=d.get("health") or {},
        scaling={"min": 2, "max": 4, "targetCPU": 70, **(d.get("scaling") or {})},
        secrets=secrets,
        identity=d.get("identity") or {},
        ingress={"path": "/", **ingress} if ingress is not None else None,
        metrics={"path": "/metrics", **d["metrics"]} if d.get("metrics") is not None else None,
        strategy=(d.get("rollout") or {}).get("strategy", "sequential"),
        stage_overrides=d.get("stages") or {},
    )
    _check(spec)
    for stage in spec.stage_overrides:
        spec.for_stage(stage)  # validate every stage's merged result up front
    return spec
