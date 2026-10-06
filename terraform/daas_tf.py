#!/usr/bin/env python3
"""Everything Terraform needs that HCL can't read from YAML itself, generated from the platform folder
(DAAS_PLATFORM_DIR, default ../platform): terraform.yaml and stages.yaml.

  daas_tf.py config     write live/_config.tf.json (terraform block: versions, providers, state backend)
  daas_tf.py pipeline   print the GitLab child pipeline: plan every stage, apply on the default branch
                        in stages.yaml order (stages with autoApply: false wait for a click)
"""
import json
import os
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent
PLATFORM = Path(os.getenv("DAAS_PLATFORM_DIR") or ROOT.parent / "platform")
LIVE = "terraform/live"


def load() -> dict:
    return {"terraform": yaml.safe_load((PLATFORM / "terraform.yaml").read_text()),
            "stages": yaml.safe_load((PLATFORM / "stages.yaml").read_text())}


def terraform_block(d: dict) -> dict:
    tf = d["terraform"]
    return {"terraform": {
        "required_version": tf["requiredVersion"],
        "required_providers": {name: {"source": p["source"], "version": p["version"]}
                               for name, p in tf["providers"].items()},
        "backend": {"gcs": {"bucket": tf["state"]["bucket"], "prefix": tf["state"]["prefix"]}},
    }}


def auto_apply(cfg: dict) -> bool:
    return cfg.get("autoApply", True)


def gcp_credential(provider: str, service_account: str) -> str:
    """External-account credential: exchange the GitLab OIDC token for GCP access as `service_account`."""
    return json.dumps({
        "type": "external_account",
        "audience": f"//iam.googleapis.com/{provider}",
        "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
        "token_url": "https://sts.googleapis.com/v1/token",
        "credential_source": {"file": "/tmp/gcp_token"},
        "service_account_impersonation_url":
            f"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{service_account}:generateAccessToken",
    })


def identity_vars(ci: dict, mode: str, account: str) -> dict:
    ident = ci[mode]
    return {"DAAS_GCP_CRED": gcp_credential(ci["gcpWorkloadIdentityProvider"], ident["gcpServiceAccount"]),
            "AWS_ROLE_ARN": f"arn:aws:iam::{account}:role/{ident['awsRole']}"}


def pipeline(d: dict, on_default_branch: bool) -> dict:
    tf, ci = d["terraform"], d["terraform"]["ci"]
    out: dict = {
        "stages": ["plan", "apply"],
        "default": {"image": {"name": tf["image"], "entrypoint": [""]}},
        "variables": {
            "DAAS_TF_CONFIG": json.dumps(terraform_block(d)),
            # the platform folder Terraform reads (same one this pipeline was generated from)
            "TF_VAR_platform_dir": "$CI_PROJECT_DIR/" + os.path.relpath(PLATFORM.resolve(), ROOT.parent),
            "AWS_WEB_IDENTITY_TOKEN_FILE": "/tmp/aws_token",
            "GOOGLE_APPLICATION_CREDENTIALS": "/tmp/gcp.json",
        },
        ".tf": {
            # GitLab OIDC -> GCP (workload identity federation) and AWS (web identity). No stored keys.
            "id_tokens": {"GCP_ID_TOKEN": {"aud": f"https://iam.googleapis.com/{ci['gcpWorkloadIdentityProvider']}"},
                          "AWS_ID_TOKEN": {"aud": "sts.amazonaws.com"}},
            "before_script": [
                "apk add --no-cache jq >/dev/null",
                'printf %s "$GCP_ID_TOKEN" > /tmp/gcp_token && printf %s "$AWS_ID_TOKEN" > /tmp/aws_token',
                'printf %s "$DAAS_GCP_CRED" > /tmp/gcp.json',
                f'printf %s "$DAAS_TF_CONFIG" > {LIVE}/_config.tf.json',
                f"cd {LIVE}",
                "terraform init -input=false",
                'terraform workspace select -or-create "$STAGE"',
            ],
        },
    }
    prev_apply = None
    for stage, cfg in d["stages"].items():
        account, tier = str(cfg["aws"]["account"]), cfg["gitlabTier"]
        rg = f"daas-terraform-{stage}"  # one run per stage state at a time
        env = {"name": f"terraform/{stage}", "deployment_tier": tier}
        out[f"plan:{stage}"] = {
            "extends": ".tf", "stage": "plan", "resource_group": rg,
            "variables": {"STAGE": stage, **identity_vars(ci, "plan", account)},
            "environment": {**env, "action": "prepare"},
            "script": [
                "terraform plan -input=false -lock=false -out=plan.tfplan",
                "terraform show -no-color plan.tfplan > plan.txt",
                # GitLab's Terraform MR widget: counts of create/update/delete
                "terraform show -json plan.tfplan | jq -r '([.resource_changes[]?.change.actions?]|flatten)"
                " | {create:(map(select(.==\"create\"))|length), update:(map(select(.==\"update\"))|length),"
                " delete:(map(select(.==\"delete\"))|length)}' > plan.json",
            ],
            "artifacts": {"name": f"plan-{stage}", "expire_in": "1 week",
                          "paths": [f"{LIVE}/plan.tfplan", f"{LIVE}/plan.txt", f"{LIVE}/.terraform.lock.hcl"],
                          "reports": {"terraform": f"{LIVE}/plan.json"}},
        }
        if on_default_branch:
            needs = [f"plan:{stage}"] + ([{"job": prev_apply, "artifacts": False}] if prev_apply else [])
            job = {
                "extends": ".tf", "stage": "apply", "resource_group": rg, "needs": needs,
                "variables": {"STAGE": stage, **identity_vars(ci, "apply", account)},
                # Protect terraform/<stage> environments in GitLab to require approvals for applies.
                "environment": env,
                # Applies exactly the reviewed plan; fails if state moved since (stale plan).
                "script": ["terraform apply -input=false plan.tfplan"],
            }
            if not auto_apply(cfg):
                job["when"] = "manual"
                job["allow_failure"] = False  # later stages wait for this click
            out[f"apply:{stage}"] = job
            prev_apply = f"apply:{stage}"
    return out


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    d = load()
    if cmd == "config":
        target = ROOT / "live" / "_config.tf.json"
        target.write_text(json.dumps(terraform_block(d), indent=2) + "\n")
        print(f"wrote {target.relative_to(ROOT.parent)}")
    elif cmd == "pipeline":
        on_default = os.getenv("CI_COMMIT_BRANCH") and os.getenv("CI_COMMIT_BRANCH") == os.getenv("CI_DEFAULT_BRANCH")
        yaml.safe_dump(pipeline(d, bool(on_default)), sys.stdout, sort_keys=False, width=200)
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
