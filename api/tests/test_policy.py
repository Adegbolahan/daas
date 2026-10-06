import pytest

from daas_api.policy import Platform, PolicyError, infer_tier, preview_slug

STAGES = {
    "preview": {"gitlabTier": "development", "environments": ["review/*"], "preview": True},
    "qa": {"gitlabTier": "testing", "environments": ["qa", "qa-*"]},
    "uat": {"gitlabTier": "testing"},
    "production": {"gitlabTier": "production", "environments": ["production", "production-*"]},
}


def team(name="pay", stages=("preview", "qa", "uat", "production"), clusters=(), **extra):
    return {"name": name, "namespace": name, "projects": [f"acme/{name}/*"],
            "stages": {s: {} for s in stages}, "clusters": list(clusters), "secrets": {}, **extra}


def platform(stages=None, teams=None, **extra) -> Platform:
    return Platform({"stages": stages if stages is not None else STAGES,
                     "teams": teams if teams is not None else [team()], **extra})


def test_environment_routing():
    p = platform()
    assert p.resolve_env("qa-7", "testing").stage == "qa"
    assert p.resolve_env("uat", "testing").stage == "uat"            # default route = stage name
    assert p.resolve_env("production-eu", "production").stage == "production"
    e = p.resolve_env("review/MR 42!", "development")
    assert e.is_preview and e.slug == "mr-42"


@pytest.mark.parametrize("env,tier,msg", [
    ("sandbox", "other", "doesn't map to any stage"),
    ("qa", "staging", "must declare deployment_tier 'testing'"),
    ("uat", None, "must declare deployment_tier 'testing'"),
])
def test_environment_routing_rejects(env, tier, msg):
    with pytest.raises(PolicyError, match=msg):
        platform().resolve_env(env, tier)


def test_preview_slug():
    assert preview_slug("review/" + "x" * 50, "review/*") == "x" * 20
    assert preview_slug("feature/abc", "feature/*") == "abc"
    with pytest.raises(PolicyError):
        preview_slug("review/---", "review/*")


@pytest.mark.parametrize("kw,msg", [
    ({"stages": {"Prod": {"gitlabTier": "production"}}}, "must match"),
    ({"stages": {"prod": {"gitlabTier": "prd"}}}, "gitlabTier must be one of"),
    ({"stages": {"a": {"gitlabTier": "testing", "preview": True}, "b": {"gitlabTier": "testing", "preview": True}}},
     "at most one stage"),
    ({"stages": {"a": {"gitlabTier": "testing", "environments": ["x"]}, "b": {"gitlabTier": "testing", "environments": ["x"]}}},
     "used by both"),
    ({"teams": [team(stages=("nope",))]}, "unknown stages"),
    ({"teams": [team(name="x" * 22)]}, "<= 21 characters"),
    ({"teams": [team(), team(name="other", namespace="pay")]}, "already used"),
    ({"teams": [team(clusters=[{"name": "c1", "stage": "qa", "provider": "gke", "region": "r", "gcpProject": "p"}])]},
     "must start with 'pay-'"),
    ({"teams": [team(stages=("qa",), clusters=[{"name": "pay-c", "stage": "uat", "provider": "gke", "region": "r",
                                                   "gcpProject": "p"}])]}, "doesn't enable"),
    ({"teams": [team(clusters=[{"name": "pay-c", "stage": "qa", "provider": "eks", "region": "r"}])]}, "needs oidcIssuer"),
    ({"teams": [team(clusters=[{"name": "pay-c", "stage": "qa", "provider": "gke", "region": "r", "zone": "z"}])]},
     "unexpected keyword"),
    ({"teams": [team(clusters=[{"name": f"pay-p{i}", "stage": "preview", "provider": "gke", "region": "r",
                                "gcpProject": "p"} for i in range(2)])]}, "at most one cluster in the preview stage"),
    ({"conventions": {"typo": 1}}, "unknown keys"),
])
def test_platform_validation(kw, msg):
    with pytest.raises(ValueError, match=msg):
        platform(**kw)


def test_conventions_drive_names():
    p = platform(conventions={"secretKeySeparator": "--", "previewNamespaceSuffix": "-pr"})
    assert p.conventions.remote_key("pay", "api", "DB") == "pay--api--DB"
    assert p.namespace(p.teams[0], "preview") == "pay-pr"


@pytest.mark.parametrize("name,tier", [("production", "production"), ("prod-eu", "production"),
                                       ("staging", "staging"), ("review/mr-1", "development"),
                                       ("qa", "testing"), ("sandbox", "other")])
def test_infer_tier(name, tier):
    assert infer_tier(name) == tier
