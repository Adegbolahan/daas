# Cross-cloud secret access for ONE stage. Every value comes from the platform folder
# (var.platform_dir, default ../../platform):
#   stages.yaml, conventions.yaml, service.yaml     platform-owned
#   teams/<team>/access.yaml, clusters.yaml           one folder per team (dedicated clusters)
#
# Terraform only allows literals in the `terraform {}` block (versions, providers, backend), so that
# block is generated from platform/terraform.yaml into _config.tf.json:
#
#   python3 ../daas_tf.py config                      # writes live/_config.tf.json
#   terraform init
#   terraform workspace select -or-create qa          # workspace = stage = its own state
#   terraform plan
#
# The DAAS pipeline (.gitlab-ci.yml) does this for every stage. Nothing here is per-stage or per-team.

variable "platform_dir" {
  description = "Path to the platform folder. Empty = ../../platform"
  type        = string
  default     = ""
}

locals {
  dir         = var.platform_dir != "" ? var.platform_dir : "${path.module}/../../platform"
  stages      = yamldecode(file("${local.dir}/stages.yaml"))
  conventions = yamldecode(file("${local.dir}/conventions.yaml"))
  service     = yamldecode(file("${local.dir}/service.yaml"))

  # Workspace must name a stage (file() is only used to fail with a readable message).
  stage = contains(keys(local.stages), terraform.workspace) ? terraform.workspace : file(
    "ERROR: workspace '${terraform.workspace}' is not a stage in ${local.dir}/stages.yaml; run: terraform workspace select -or-create <stage>"
  )
  cfg        = local.stages[local.stage]
  is_preview = try(local.cfg.preview, false)

  team_names = sort([for f in fileset("${local.dir}/teams", "*/access.yaml") : dirname(f)])
  # Every team folder has access.yaml and clusters.yaml (a list; `[]` until the team has clusters).
  teams = [for n in local.team_names : merge(yamldecode(file("${local.dir}/teams/${n}/access.yaml")), {
    name     = n
    clusters = yamldecode(file("${local.dir}/teams/${n}/clusters.yaml"))
  })]

  stage_teams = [for t in local.teams : {
    name       = t.name
    namespaces = [local.is_preview ? "${try(t.namespace, t.name)}${local.conventions.previewNamespaceSuffix}" : try(t.namespace, t.name)]
    gke = [for c in t.clusters : { name = c.name, project = try(c.gcpProject, ""), location = c.region }
    if c.stage == local.stage && c.provider == "gke"]
    eks = [for c in t.clusters : { name = c.name, oidc_issuer = try(c.oidcIssuer, "") }
    if c.stage == local.stage && c.provider == "eks"]
  } if contains(keys(try(t.stages, {})), local.stage)]
}

provider "google" {
  project = local.cfg.gcp.project
}

# Credentials come from the environment (the pipeline sets plan or apply identities per job;
# locally, use a profile for the stage's account). allowed_account_ids stops a wrong-account apply.
provider "aws" {
  region              = local.cfg.aws.region
  allowed_account_ids = [tostring(local.cfg.aws.account)]
  default_tags {
    tags = { "managed-by" = "daas", "daas-stage" = local.stage }
  }
}

module "secrets" {
  source = "../modules/secrets-stage"

  stage                       = local.stage
  gcp_project_id              = local.cfg.gcp.project
  gcp_project_number          = tostring(local.cfg.gcp.projectNumber)
  teams                       = local.stage_teams
  existing_oidc_provider_arns = try(local.cfg.aws.existingOidcProviders, {})
  daas_gcp_writer_member      = local.service.identities.gcpMember
  daas_aws_principal_arn      = local.service.identities.awsPrincipalArn
  conventions = {
    secretKeySeparator    = local.conventions.secretKeySeparator
    secretsServiceAccount = local.conventions.secretsServiceAccount
    gcpReaderPrefix       = local.conventions.gcpReaderPrefix
    awsReaderRolePrefix   = local.conventions.awsReaderRolePrefix
    awsWriterRole         = local.conventions.awsWriterRole
    wifPool               = local.conventions.wifPool
    wifTokenAudience      = local.conventions.wifTokenAudience
  }
}
