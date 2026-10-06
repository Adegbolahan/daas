"""Delete expired previews (safety net for MRs whose GitLab stop job never ran)."""
import logging
import threading
from datetime import datetime, timezone

from .gitops import GitOpsRepo

log = logging.getLogger("daas.reaper")


def reap(repo: GitOpsRepo, now: datetime | None = None) -> list[str]:
    now = now or datetime.now(timezone.utc)
    expired = [d for d, meta in repo.all_meta()
               if meta.get("preview") and meta.get("expiresAt")
               and datetime.fromisoformat(meta["expiresAt"]) <= now]
    if expired:
        repo.remove(expired, f"reaper: remove {len(expired)} expired preview(s)")
        log.info("reaped %s", expired)
    return expired


def start(repo: GitOpsRepo, interval_seconds: int) -> threading.Thread:
    stop = threading.Event()

    def loop():
        while not stop.wait(interval_seconds):
            try:
                reap(repo)
            except Exception:  # noqa: BLE001 — keep the loop alive
                log.exception("reaper run failed")

    t = threading.Thread(target=loop, name="daas-reaper", daemon=True)
    t.start()
    return t
