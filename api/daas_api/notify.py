"""Best-effort outbound notifications: deploy results to chat webhooks, and GitOps pushes to Argo CD."""
import logging
import os
from urllib.parse import urlparse

import httpx

log = logging.getLogger("daas.notify")


def _post(url: str, payload: dict, headers: dict | None = None) -> None:
    try:
        httpx.post(url, json=payload, headers=headers or {}, timeout=5)
    except httpx.HTTPError as e:  # never fail a deploy because a notification failed
        log.warning("notification to %s failed: %s", urlparse(url).netloc, e)


class Notifier:
    """Posts {"text": ...} (Slack/Teams/Mattermost-compatible) when a deployment finishes.

    Global webhooks: DAAS_NOTIFY_WEBHOOKS (comma-separated). Per team: the env var named by
    `notify.webhookEnv` in access.yaml. URLs are secrets, so they come from the environment.
    """

    def __init__(self, global_env: str = "DAAS_NOTIFY_WEBHOOKS"):
        self.global_urls = [u for u in os.getenv(global_env, "").split(",") if u]

    def deployment_finished(self, rec: dict, team_env: str | None) -> None:
        urls = self.global_urls + ([os.environ[team_env]] if team_env and os.getenv(team_env) else [])
        if not urls:
            return
        icon = {"succeeded": "✅", "failed": "❌"}.get(rec.get("status"), "ℹ️")
        clusters = ", ".join(f"{c['cluster']}={c.get('status')}" for c in rec.get("clusters", []))
        text = (f"{icon} {rec.get('app')} → {rec.get('environment')} ({rec.get('stage')}): {rec.get('status')}"
                f"\nimage {rec.get('image')} · {clusters}"
                + (f"\n{rec['message']}" if rec.get("message") else ""))
        for u in urls:
            _post(u, {"text": text, "deployment": rec})


class ArgoWebhook:
    """Tell Argo CD about a GitOps push right away instead of waiting for its ~3 min poll.

    DAAS_ARGOCD_WEBHOOK_URLS: comma-separated, typically argocd-server's /api/webhook and the
    applicationset-controller's /api/webhook. DAAS_ARGOCD_WEBHOOK_SECRET: the GitLab webhook secret
    configured in Argo CD (sent as X-Gitlab-Token).
    """

    def __init__(self, repo_url: str):
        self.urls = [u for u in os.getenv("DAAS_ARGOCD_WEBHOOK_URLS", "").split(",") if u]
        self.secret = os.getenv("DAAS_ARGOCD_WEBHOOK_SECRET", "")
        web = repo_url.removesuffix(".git")
        self.project = {"web_url": web, "git_http_url": repo_url, "http_url": repo_url}

    def pushed(self, sha: str, files: list[str]) -> None:
        if not self.urls:
            return
        payload = {"object_kind": "push", "ref": "refs/heads/main", "after": sha, "project": self.project,
                   "repository": {"git_http_url": self.project["git_http_url"]},
                   "commits": [{"id": sha, "added": files, "modified": files, "removed": []}]}
        headers = {"X-Gitlab-Event": "Push Hook", **({"X-Gitlab-Token": self.secret} if self.secret else {})}
        for u in self.urls:
            _post(u, payload, headers)
