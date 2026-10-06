"""Decide whether a wave is healthy before moving to the next one."""
import time
from typing import Protocol

import httpx


def argo_app_name(cluster: str, namespace: str, app: str) -> str:
    # Must match the daas-apps ApplicationSet template in platform_render.application_sets()
    return f"{cluster}-{namespace}-{app}"


class HealthChecker(Protocol):
    def wait(self, cluster: str, namespace: str, app: str, revision: str, timeout: int) -> tuple[bool, str]: ...


class CommitOnlyChecker:
    """No Argo CD configured: a successful commit counts as success."""

    verifies_health = False

    def wait(self, cluster, namespace, app, revision, timeout):
        return True, "committed (health not checked)"


class ArgoCDChecker:
    """Healthy = Argo synced a revision that INCLUDES our commit, and reports Healthy.

    Other deploys commit to the same repo, so Argo may already be on a later commit; `contains`
    (GitOpsRepo.contains) decides whether that later revision includes ours.
    """
    verifies_health = True

    def __init__(self, url: str, token: str, contains=None, poll_seconds: int = 10, client=None):
        self.client = client or httpx.Client(base_url=url, headers={"Authorization": f"Bearer {token}"}, timeout=15)
        self.contains = contains or (lambda commit, rev: commit == rev)
        self.poll = poll_seconds

    def wait(self, cluster, namespace, app, revision, timeout):
        name = argo_app_name(cluster, namespace, app)
        deadline = time.monotonic() + timeout
        last = "waiting for Argo CD"
        while time.monotonic() < deadline:
            try:
                r = self.client.get(f"/api/v1/applications/{name}", params={"refresh": "normal"})
                if r.status_code == 200:
                    st = r.json().get("status", {})
                    sync, health = st.get("sync", {}), st.get("health", {}).get("status")
                    last = f"sync={sync.get('status')} health={health}"
                    rev = sync.get("revision")
                    if rev and sync.get("status") == "Synced" and self.contains(revision, rev):
                        if health == "Healthy":
                            return True, last
                        if health == "Degraded":
                            return False, last
                else:
                    last = f"argo returned {r.status_code}"
            except httpx.HTTPError as e:
                last = f"argo unreachable: {e}"
            except ValueError:
                last = "argo returned a non-JSON response"
            time.sleep(self.poll)
        return False, f"timed out ({last})"
