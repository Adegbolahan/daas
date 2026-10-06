"""The GitOps repo Argo CD watches. DAAS is its only writer.

Layout:
  clusters/<cluster>/<namespace>/<name>/manifests.yaml   app manifests
  clusters/<cluster>/<namespace>/<name>/daas.json        ownership + Argo metadata (read by the ApplicationSet)
  platform/<cluster>/namespaces.yaml                     namespaces, quotas, RBAC, secret access (from platform/)
  platform/argocd/*.yaml                                 AppProjects + ApplicationSets
"""
import base64
import json
import os
import shutil
import subprocess
import threading
from pathlib import Path


class GitError(RuntimeError):
    pass


class GitOpsRepo:
    """push=False: a local repo (dev/tests). push=True: a clone of `remote` that DAAS pulls/pushes.

    token: a GitLab project/deploy token with write_repository, sent as HTTP basic auth
    (never written into .git/config or the remote URL).
    """

    def __init__(self, path: Path, push: bool = False, remote: str = "", token: str = ""):
        self.path = path
        self.push = push
        self._env = None
        self._secret = ""
        if token:
            # via GIT_CONFIG_* env vars: not visible in `ps`, not part of any error message
            basic = base64.b64encode(f"oauth2:{token}".encode()).decode()
            self._secret = basic
            self._env = {**os.environ, "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.extraHeader",
                         "GIT_CONFIG_VALUE_0": f"Authorization: Basic {basic}", "GIT_TERMINAL_PROMPT": "0"}
        self._lock = threading.RLock()
        if not (path / ".git").exists():
            if push:
                if not remote:
                    raise ValueError("GitOps push is on but no repo URL is configured (service.yaml gitopsRepo)")
                path.parent.mkdir(parents=True, exist_ok=True)
                self._run(["clone", "-q", remote, str(path)], cwd=path.parent)
            else:
                path.mkdir(parents=True, exist_ok=True)
                self._git("init", "-q", "-b", "main")
                self._git("commit", "-q", "--allow-empty", "-m", "init")

    def _run(self, args: list[str], cwd: Path) -> str:
        r = subprocess.run(["git", "-c", "user.name=daas", "-c", "user.email=daas@platform", *args],
                           cwd=cwd, capture_output=True, text=True, env=self._env)
        if r.returncode != 0:
            msg = (r.stderr or r.stdout).strip()
            if self._secret:
                msg = msg.replace(self._secret, "***")
            raise GitError(f"git {args[0]} failed: {msg}")
        return r.stdout.strip()

    def _git(self, *args: str) -> str:
        return self._run(list(args), cwd=self.path)

    def contains(self, commit: str, revision: str) -> bool:
        """True if `revision` includes `commit` (equal, or a later commit on top of it)."""
        if commit == revision:
            return True
        with self._lock:
            if self.push:
                try:
                    self._git("fetch", "-q", "origin")
                except GitError:
                    pass
            r = subprocess.run(["git", "merge-base", "--is-ancestor", commit, revision],
                               cwd=self.path, capture_output=True)
            return r.returncode == 0

    @staticmethod
    def app_dir(cluster: str, namespace: str, name: str) -> str:
        return f"clusters/{cluster}/{namespace}/{name}"

    def _commit(self, message: str) -> str:
        self._git("add", "-A")
        if self._git("status", "--porcelain"):
            self._git("commit", "-q", "-m", message)
            if self.push:
                self._git("push", "-q")
        return self._git("rev-parse", "HEAD")

    def _sync(self) -> None:
        if self.push:
            self._git("pull", "-q", "--rebase")

    def write(self, files: dict[str, str], message: str) -> str:
        """files: {relative path: content}. Returns HEAD after committing (no-op if unchanged)."""
        with self._lock:
            self._sync()
            for rel, content in files.items():
                f = self.path / rel
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(content)
            return self._commit(message)

    def remove(self, dirs: list[str], message: str) -> str:
        with self._lock:
            self._sync()
            for rel in dirs:
                shutil.rmtree(self.path / rel, ignore_errors=True)
            return self._commit(message)

    def read_meta(self, app_dir: str) -> dict | None:
        f = self.path / app_dir / "daas.json"
        return json.loads(f.read_text()) if f.exists() else None

    def all_meta(self) -> list[tuple[str, dict]]:
        with self._lock:
            return [(str(f.parent.relative_to(self.path)), json.loads(f.read_text()))
                    for f in sorted(self.path.glob("clusters/*/*/*/daas.json"))]
