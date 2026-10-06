"""Naming conventions shared by the API, rendered manifests and terraform/.

Values come from platform/conventions.yaml (Terraform reads the same file), so the
two sides can't drift. The defaults below only apply to keys the file leaves out.
"""
from dataclasses import dataclass, field, fields


@dataclass(frozen=True)
class Conventions:
    secretKeySeparator: str = "_"
    secretsServiceAccount: str = "daas-secrets"
    secretStores: dict = field(default_factory=lambda: {"gcp": "daas-gcp", "aws": "daas-aws"})
    gcpReaderPrefix: str = "daas-sec-"
    awsReaderRolePrefix: str = "daas-secrets-"
    awsWriterRole: str = "daas-secrets-writer"
    wifPool: str = "daas-k8s"
    wifTokenAudience: str = "daas-gcp"
    previewNamespaceSuffix: str = "-preview"
    platformSecretsApp: str = "daas"          # reserved app name for platform-owned team secrets
    registryPullSecret: str = "daas-registry" # imagePullSecret rendered in every team namespace
    defaultPodSecurity: str = "restricted"    # Pod Security Standard unless a team sets podSecurity

    @classmethod
    def from_dict(cls, d: dict | None) -> "Conventions":
        d = d or {}
        unknown = set(d) - {f.name for f in fields(cls)}
        if unknown:
            raise ValueError(f"conventions.yaml: unknown keys {sorted(unknown)}")
        return cls(**d)

    # --- names ---------------------------------------------------------------
    def remote_key(self, team: str, app: str, name: str) -> str:
        return self.secretKeySeparator.join((team, app, name))

    def gsa_email(self, team: str, ts: "StageSecrets") -> str:
        return f"{self.gcpReaderPrefix}{team}@{ts.gcp_project}.iam.gserviceaccount.com"

    def aws_reader_role(self, team: str, ts: "StageSecrets") -> str:
        return f"arn:aws:iam::{ts.aws_account}:role/{self.awsReaderRolePrefix}{team}"

    def aws_writer_role(self, ts: "StageSecrets") -> str:
        return f"arn:aws:iam::{ts.aws_account}:role/{self.awsWriterRole}"

    def wif_audience(self, cluster_name: str, ts: "StageSecrets") -> str:
        return (f"//iam.googleapis.com/projects/{ts.gcp_project_number}/locations/global/"
                f"workloadIdentityPools/{self.wifPool}/providers/{cluster_name}")

    def max_team_name(self) -> int:
        return 30 - len(self.gcpReaderPrefix)  # GCP service account ids are <= 30 chars


@dataclass(frozen=True)
class StageSecrets:
    """Where one stage's secrets live."""
    stage: str
    gcp_project: str
    gcp_project_number: str
    aws_account: str
    aws_region: str


def stage_secrets(stages: dict) -> dict[str, StageSecrets]:
    out = {}
    for n, v in stages.items():
        if "gcp" not in v and "aws" not in v:
            continue
        try:
            out[n] = StageSecrets(n, v["gcp"]["project"], str(v["gcp"]["projectNumber"]),
                                  str(v["aws"]["account"]), v["aws"]["region"])
        except (KeyError, TypeError) as e:
            raise ValueError(f"stages.yaml: {n} needs gcp.project, gcp.projectNumber, aws.account and "
                             f"aws.region (missing {e})") from None
    return out
