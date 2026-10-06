"""Deployment records, in SQLite so they survive a restart (DAAS_STATE_DB; empty = in memory for tests/dev).

Rollouts run inside the API process. If it restarts mid-rollout, the interrupted records are marked
failed on startup (the GitOps repo keeps whatever waves were committed; re-running the pipeline job
converges). Still one replica: SQLite on a volume is not shared storage.
"""
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, path: str = ""):
        self._db = sqlite3.connect(path or ":memory:", check_same_thread=False)
        self._db.execute("CREATE TABLE IF NOT EXISTS deployments (id TEXT PRIMARY KEY, doc TEXT NOT NULL)")
        self._db.commit()
        self._lock = threading.Lock()

    def _save(self, rec: dict) -> None:
        self._db.execute("INSERT OR REPLACE INTO deployments (id, doc) VALUES (?, ?)", (rec["id"], json.dumps(rec)))
        self._db.commit()

    def _load(self, rid: str) -> dict | None:
        row = self._db.execute("SELECT doc FROM deployments WHERE id = ?", (rid,)).fetchone()
        return json.loads(row[0]) if row else None

    def create(self, record: dict) -> dict:
        rec = {"id": f"dep-{uuid.uuid4().hex[:12]}", "createdAt": now(), **record}
        with self._lock:
            self._save(rec)
        return rec

    def get(self, rid: str) -> dict | None:
        with self._lock:
            return self._load(rid)

    def update(self, rid: str, **fields) -> dict:
        with self._lock:
            rec = self._load(rid)
            rec.update(fields, updatedAt=now())
            self._save(rec)
            return rec

    def set_cluster(self, rid: str, cluster: str, **fields) -> None:
        with self._lock:
            rec = self._load(rid)
            for c in rec["clusters"]:
                if c["cluster"] == cluster:
                    c.update(fields)
            self._save(rec)

    def find(self, **filters) -> list[dict]:
        """Newest first; filters match top-level fields (e.g. team, app, environment)."""
        with self._lock:
            rows = [json.loads(d) for (d,) in self._db.execute("SELECT doc FROM deployments").fetchall()]
        rows = [r for r in rows if all(v is None or r.get(k) == v for k, v in filters.items())]
        return sorted(rows, key=lambda r: r.get("createdAt", ""), reverse=True)

    def interrupt_unfinished(self) -> list[str]:
        """On startup: rollouts that were running when the process stopped can't resume."""
        with self._lock:
            ids = []
            for rid, doc in self._db.execute("SELECT id, doc FROM deployments").fetchall():
                rec = json.loads(doc)
                if rec.get("status") in ("pending", "running"):
                    rec.update(status="failed", updatedAt=now(),
                               message="interrupted by a DAAS restart; re-run the pipeline job")
                    self._save(rec)
                    ids.append(rid)
            return ids
