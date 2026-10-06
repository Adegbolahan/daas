"""Real token verification (GitLab CI OIDC and Entra ID), with a locally generated RSA key."""
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException

from daas_api import auth, entra
from daas_api.config import Settings

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class FakeJWKS:
    def get_signing_key_from_jwt(self, token):
        return type("K", (), {"key": KEY.public_key()})()


@pytest.fixture(autouse=True)
def fake_jwks(monkeypatch):
    monkeypatch.setattr(auth, "_jwks", lambda url: FakeJWKS())
    monkeypatch.setattr(entra, "_jwks", lambda tenant: FakeJWKS())


def token(claims, key=KEY):
    return jwt.encode({"iat": int(time.time()), "exp": int(time.time()) + 300, **claims}, key, algorithm="RS256")


# ---------- GitLab CI id_token ----------

GL = Settings(auth_mode="gitlab", gitlab_url="https://gitlab.example.com", audience="https://daas.example.com",
              allow_unverified_health=True)
GL_CLAIMS = {"iss": "https://gitlab.example.com", "aud": "https://daas.example.com",
             "project_path": "acme/payments/api", "environment": "production", "deployment_tier": "production"}


def gitlab_claims(tok):
    return auth.make_claims_dependency(GL)(authorization=f"Bearer {tok}", x_daas_project=None,
                                           x_daas_environment=None, x_daas_environment_protected="true",
                                           x_daas_tier=None)


def test_gitlab_token_accepted():
    assert gitlab_claims(token(GL_CLAIMS))["project_path"] == "acme/payments/api"


@pytest.mark.parametrize("override,key", [
    ({"aud": "https://other"}, KEY),
    ({"iss": "https://evil.example.com"}, KEY),
    ({"exp": int(time.time()) - 10}, KEY),
    ({}, OTHER),
])
def test_gitlab_token_rejected(override, key):
    with pytest.raises(HTTPException) as e:
        gitlab_claims(token({**GL_CLAIMS, **override}, key))
    assert e.value.status_code == 401


def test_gitlab_mode_ignores_dev_headers():
    dep = auth.make_claims_dependency(GL)
    with pytest.raises(HTTPException):
        dep(authorization=None, x_daas_project="acme/payments/api", x_daas_environment="production",
            x_daas_environment_protected="true", x_daas_tier="production")


# ---------- Entra ID ----------

TENANT = "11111111-2222-3333-4444-555555555555"
EN = Settings(auth_mode="gitlab", entra_tenant_id=TENANT, entra_audience="api://daas", allow_unverified_health=True)
EN_CLAIMS = {"iss": f"https://login.microsoftonline.com/{TENANT}/v2.0", "tid": TENANT, "aud": "api://daas",
             "preferred_username": "ada@acme.com", "roles": ["payments.secrets"]}


def entra_user(tok):
    return entra.make_user_dependency(EN)(authorization=f"Bearer {tok}", x_daas_user=None, x_daas_roles=None)


def test_entra_token_accepted_v2_and_v1():
    assert entra_user(token(EN_CLAIMS)) == {"user": "ada@acme.com", "roles": ["payments.secrets"]}
    v1 = {**EN_CLAIMS, "iss": f"https://sts.windows.net/{TENANT}/"}
    assert entra_user(token(v1))["user"] == "ada@acme.com"


@pytest.mark.parametrize("override", [
    {"tid": "99999999-0000-0000-0000-000000000000"},
    {"iss": "https://login.microsoftonline.com/common/v2.0"},
    {"aud": "api://other"},
])
def test_entra_token_rejected(override):
    with pytest.raises(HTTPException) as e:
        entra_user(token({**EN_CLAIMS, **override}))
    assert e.value.status_code == 401


def test_entra_group_overage_refused():
    with pytest.raises(HTTPException) as e:
        entra_user(token({**EN_CLAIMS, "_claim_names": {"groups": "src1"}}))
    assert e.value.status_code == 403


def test_entra_not_configured():
    dep = entra.make_user_dependency(Settings(auth_mode="gitlab", allow_unverified_health=True))
    with pytest.raises(HTTPException) as e:
        dep(authorization="Bearer x", x_daas_user=None, x_daas_roles=None)
    assert e.value.status_code == 503
