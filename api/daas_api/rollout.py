"""Plan waves and execute them: commit a wave, wait for health, continue or stop."""
from .gitops import GitOpsRepo
from .health import HealthChecker
from .render import Placement
from .store import Store


def plan_waves(placements: list[Placement], strategy: str) -> list[list[Placement]]:
    if strategy == "parallel" or len(placements) == 1:
        return [placements]
    return [[p] for p in placements]  # sequential: listed order, first is the canary


def execute(rid: str, waves: list[list[Placement]], files: dict[str, dict[str, str]], label: str,
            repo: GitOpsRepo, checker: HealthChecker, store: Store, timeout: int,
            on_commit=None, on_done=None) -> None:
    """files: {cluster name: {relative path: content}}.

    on_commit(sha, paths): after each wave is pushed (e.g. poke Argo CD's webhook).
    on_done(record): once, with the final record (e.g. notifications).
    """
    try:
        _execute(rid, waves, files, label, repo, checker, store, timeout, on_commit)
    except Exception as e:  # noqa: BLE001 — never leave a record stuck in "running"
        store.update(rid, status="failed", message=f"rollout error: {type(e).__name__}: {e}")
    finally:
        if on_done:
            on_done(store.get(rid))


def _execute(rid, waves, files, label, repo, checker, store, timeout, on_commit) -> None:
    store.update(rid, status="running")
    ok_status = "healthy" if getattr(checker, "verifies_health", True) else "committed"
    for i, wave in enumerate(waves, start=1):
        wave_files = {k: v for p in wave for k, v in files[p.cluster.name].items()}
        try:
            sha = repo.write(wave_files, f"deploy {label} wave {i} ({rid})")
        except Exception as e:  # noqa: BLE001 — surface any git failure to the caller
            store.update(rid, status="failed", message=f"wave {i}: git commit failed: {e}")
            return
        if on_commit:
            on_commit(sha, sorted(wave_files))
        for p in wave:
            store.set_cluster(rid, p.cluster.name, status="syncing", revision=sha)
        failed = []
        for p in wave:
            ok, detail = checker.wait(p.cluster.name, p.namespace, p.name, sha, timeout)
            store.set_cluster(rid, p.cluster.name, status=ok_status if ok else "unhealthy", detail=detail)
            if not ok:
                failed.append(p.cluster.name)
        if failed:
            store.update(rid, status="failed",
                         message=f"wave {i} unhealthy on {', '.join(failed)}; later waves not started. "
                                 f"Roll back by redeploying the previous image.")
            return
    store.update(rid, status="succeeded")
