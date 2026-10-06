"""Entra ID (Azure AD) auth for humans calling the secrets API.

Users get a token for the DAAS app registration, e.g.
    az account get-access-token --scope api://daas/.default --query accessToken -o tsv
Authorization uses the token's `roles` (app roles, recommended) and `groups` (object IDs) claims,
matched against `writers` in platform/teams/<team>/secrets.yaml.
"""
from functools import lru_cache

import jwt
from fastapi import Header, HTTPException

from .config import Settings


@lru_cache
def _jwks(tenant: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys", cache_keys=True)


def verify(token: str, s: Settings) -> dict:
    key = _jwks(s.entra_tenant_id).get_signing_key_from_jwt(token)
    claims = jwt.decode(token, key.key, algorithms=["RS256"], audience=s.entra_audience,
                        options={"verify_iss": False})
    # v2 tokens: login.microsoftonline.com/<tid>/v2.0 ; v1 tokens: sts.windows.net/<tid>/
    allowed = {f"https://login.microsoftonline.com/{s.entra_tenant_id}/v2.0",
               f"https://sts.windows.net/{s.entra_tenant_id}/"}
    if claims.get("iss") not in allowed or claims.get("tid") != s.entra_tenant_id:
        raise jwt.InvalidIssuerError("token is not from the configured Entra tenant")
    return claims


def make_user_dependency(s: Settings):
    def user(authorization: str | None = Header(None),
             x_daas_user: str | None = Header(None),
             x_daas_roles: str | None = Header(None)) -> dict:
        if s.auth_mode == "dev":
            # Local development only: trust headers in place of an Entra token.
            return {"user": x_daas_user or "dev", "roles": [r for r in (x_daas_roles or "").split(",") if r]}
        if not s.entra_tenant_id or not s.entra_audience:
            raise HTTPException(503, "secrets API is not configured (DAAS_ENTRA_TENANT_ID / DAAS_ENTRA_AUDIENCE)")
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "expected an Entra ID bearer token")
        try:
            c = verify(authorization.removeprefix("Bearer "), s)
        except jwt.PyJWTError as e:
            raise HTTPException(401, f"invalid token: {e}")
        if c.get("_claim_names", {}).get("groups"):
            # >200 groups: Entra omits the claim. App roles avoid this.
            raise HTTPException(403, "too many groups in token; assign a DAAS app role instead")
        return {"user": c.get("preferred_username") or c.get("upn") or c.get("oid"),
                "roles": list(c.get("roles") or []) + list(c.get("groups") or [])}
    return user
