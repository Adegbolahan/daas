"""Verify the GitLab CI OIDC id_token sent by the component."""
from functools import lru_cache

import jwt
from fastapi import Header, HTTPException

from .config import Settings


@lru_cache
def _jwks(gitlab_url: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"{gitlab_url}/oauth/discovery/keys", cache_keys=True)


def verify_token(token: str, s: Settings) -> dict:
    key = _jwks(s.gitlab_url).get_signing_key_from_jwt(token)
    return jwt.decode(token, key.key, algorithms=["RS256"], audience=s.audience, issuer=s.gitlab_url)


def make_claims_dependency(s: Settings, default_tier=None):
    """default_tier(env_name) -> tier: dev mode only, when X-DAAS-Tier isn't sent."""
    def claims(authorization: str | None = Header(None),
               x_daas_project: str | None = Header(None),
               x_daas_environment: str | None = Header(None),
               x_daas_environment_protected: str = Header("true"),
               x_daas_tier: str | None = Header(None)) -> dict:
        if s.auth_mode == "dev":
            # Local development only: trust headers in place of a signed GitLab token.
            tier = x_daas_tier or (default_tier(x_daas_environment) if default_tier and x_daas_environment else None)
            return {"project_path": x_daas_project or "", "environment": x_daas_environment, "deployment_tier": tier,
                    "environment_protected": x_daas_environment_protected, "ref_protected": "true", "sub": "dev"}
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "expected a Bearer token")
        try:
            return verify_token(authorization.removeprefix("Bearer "), s)
        except jwt.PyJWTError as e:
            raise HTTPException(401, f"invalid token: {e}")
    return claims
