"""Write/list/delete secret values in GCP Secret Manager or AWS Secrets Manager.

DAAS is write-only toward humans: it stores values and reports metadata, and never returns a value.
Credentials come from DAAS's own workload identity:
  GCP: Application Default Credentials; the daasSecretsWriter custom role on each stage's secrets project
       (create/update/delete secrets, add versions, read metadata; never versions.access).
  AWS: default credential chain, then sts:AssumeRole into conventions.awsWriterRole in each stage's account.
"""
import threading
from datetime import datetime, timedelta, timezone
from typing import Protocol

from .identity import Conventions, StageSecrets

LABELS = ("team", "app")


class SecretsBackend(Protocol):
    def put(self, ts: StageSecrets, provider: str, key: str, value: str, labels: dict) -> None: ...
    def exists(self, ts: StageSecrets, provider: str, key: str) -> bool: ...
    def list(self, ts: StageSecrets, provider: str, prefix: str) -> list[dict]: ...
    def delete(self, ts: StageSecrets, provider: str, key: str) -> bool: ...


class MemoryBackend:
    """Local dev and tests."""

    def __init__(self):
        self._d: dict[tuple, dict] = {}
        self._lock = threading.Lock()

    def put(self, ts, provider, key, value, labels):
        with self._lock:
            self._d[(ts.stage, provider, key)] = {"value": value, "updated": datetime.now(timezone.utc).isoformat()}

    def exists(self, ts, provider, key):
        return (ts.stage, provider, key) in self._d

    def list(self, ts, provider, prefix):
        return [{"key": k, "updated": v["updated"]} for (t, p, k), v in sorted(self._d.items())
                if t == ts.stage and p == provider and k.startswith(prefix)]

    def delete(self, ts, provider, key):
        return self._d.pop((ts.stage, provider, key), None) is not None


class CloudBackend:
    def __init__(self, conv: Conventions):
        self.conv = conv
        self._gcp = None
        self._aws: dict[str, object] = {}
        self._lock = threading.Lock()

    # --- GCP ---------------------------------------------------------------
    def _gcp_client(self):
        if self._gcp is None:
            from google.cloud import secretmanager  # lazy: only needed when GCP is used
            self._gcp = secretmanager.SecretManagerServiceClient()
        return self._gcp

    def _gcp_put(self, ts, key, value, labels):
        from google.api_core.exceptions import AlreadyExists
        c = self._gcp_client()
        parent = f"projects/{ts.gcp_project}"
        try:
            c.create_secret(request={"parent": parent, "secret_id": key, "secret": {
                "replication": {"automatic": {}}, "labels": {**labels, "managed-by": "daas"}}})
        except AlreadyExists:
            pass
        c.add_secret_version(request={"parent": f"{parent}/secrets/{key}", "payload": {"data": value.encode()}})

    def _gcp_exists(self, ts, key):
        from google.api_core.exceptions import NotFound
        try:
            # metadata only; DAAS never reads values
            self._gcp_client().get_secret_version(
                request={"name": f"projects/{ts.gcp_project}/secrets/{key}/versions/latest"})
            return True
        except NotFound:
            return False

    def _gcp_list(self, ts, prefix):
        out = []
        for sec in self._gcp_client().list_secrets(request={"parent": f"projects/{ts.gcp_project}",
                                                             "filter": f"name:{prefix}"}):
            key = sec.name.rsplit("/", 1)[-1]
            if key.startswith(prefix):
                out.append({"key": key, "updated": sec.create_time.isoformat() if sec.create_time else None})
        return out

    def _gcp_delete(self, ts, key):
        from google.api_core.exceptions import NotFound
        try:
            self._gcp_client().delete_secret(request={"name": f"projects/{ts.gcp_project}/secrets/{key}"})
            return True
        except NotFound:
            return False

    # --- AWS ---------------------------------------------------------------
    def _aws_client(self, ts):
        """Secrets Manager client in the stage's account, via the daas-secrets-writer role (cached until near expiry)."""
        with self._lock:
            cached = self._aws.get(ts.stage)
            if cached and cached[1] > datetime.now(timezone.utc) + timedelta(minutes=5):
                return cached[0]
            import boto3
            creds = boto3.client("sts").assume_role(RoleArn=self.conv.aws_writer_role(ts), RoleSessionName="daas")["Credentials"]
            client = boto3.client(
                "secretsmanager", region_name=ts.aws_region,
                aws_access_key_id=creds["AccessKeyId"], aws_secret_access_key=creds["SecretAccessKey"],
                aws_session_token=creds["SessionToken"])
            self._aws[ts.stage] = (client, creds["Expiration"])
            return client

    def _aws_describe(self, c, key):
        try:
            return c.describe_secret(SecretId=key)
        except c.exceptions.ResourceNotFoundException:
            return None

    def _aws_put(self, ts, key, value, labels):
        c = self._aws_client(ts)
        d = self._aws_describe(c, key)
        if d is None:
            c.create_secret(Name=key, SecretString=value,
                            Tags=[{"Key": k, "Value": v} for k, v in {**labels, "managed-by": "daas"}.items()])
            return
        if d.get("DeletedDate"):  # inside the recovery window: bring it back, then update
            c.restore_secret(SecretId=key)
        c.put_secret_value(SecretId=key, SecretString=value)

    def _aws_exists(self, ts, key):
        d = self._aws_describe(self._aws_client(ts), key)
        return d is not None and not d.get("DeletedDate")

    def _aws_list(self, ts, prefix):
        c = self._aws_client(ts)
        out = []
        for page in c.get_paginator("list_secrets").paginate(Filters=[{"Key": "name", "Values": [prefix]}]):
            for sec in page["SecretList"]:
                if sec["Name"].startswith(prefix) and not sec.get("DeletedDate"):
                    ts_ = sec.get("LastChangedDate") or sec.get("CreatedDate")
                    out.append({"key": sec["Name"], "updated": ts_.isoformat() if ts_ else None})
        return out

    def _aws_delete(self, ts, key):
        c = self._aws_client(ts)
        d = self._aws_describe(c, key)
        if d is None or d.get("DeletedDate"):
            return False
        c.delete_secret(SecretId=key, RecoveryWindowInDays=7)  # recoverable for 7 days
        return True

    # --- dispatch ----------------------------------------------------------
    def put(self, ts, provider, key, value, labels):
        (self._gcp_put if provider == "gcp" else self._aws_put)(ts, key, value, labels)

    def exists(self, ts, provider, key):
        return (self._gcp_exists if provider == "gcp" else self._aws_exists)(ts, key)

    def list(self, ts, provider, prefix):
        return (self._gcp_list if provider == "gcp" else self._aws_list)(ts, prefix)

    def delete(self, ts, provider, key):
        return (self._gcp_delete if provider == "gcp" else self._aws_delete)(ts, key)
