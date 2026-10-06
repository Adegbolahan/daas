# Secret access for one stage. Names come from platform/conventions.yaml; teams and their dedicated
# clusters from platform/teams/<team>/.
#
#   GCP project (secrets live here)                  AWS account (secrets live here)
#   ├─ SA <gcpReaderPrefix><team> (reads <team>_*)   ├─ role <awsReaderRolePrefix><team> (reads <team>_*)
#   │   ├─ from the team's GKE clusters (Workload Identity)   trusted ONLY by that team's clusters'
#   │   └─ from the team's EKS clusters (WIF pool)            OIDC issuers, for ns/<ksa>
#   └─ DAAS writer: custom role, can't read values   └─ role <awsWriterRole> (DAAS assumes it; no GetSecretValue)
#
# A team with no clusters in this stage gets no reader identities here.

locals {
  cv        = var.conventions
  ksa       = local.cv.secretsServiceAccount
  pool_id   = local.cv.wifPool
  token_aud = local.cv.wifTokenAudience

  active = { for t in var.teams : t.name => t if length(t.gke) + length(t.eks) > 0 }
  all_eks = flatten([for t in values(local.active) : t.eks])

  gke_issuer = { for t in values(local.active) : t.name => {
    for c in t.gke : c.name => "https://container.googleapis.com/v1/projects/${c.project}/locations/${c.location}/clusters/${c.name}"
  } }
  team_issuers = { for n, t in local.active : n => merge(
    { for c in t.eks : c.name => c.oidc_issuer },
    local.gke_issuer[n],
  ) }
  issuers           = merge(values(local.team_issuers)...)
  issuers_to_create = { for k, url in local.issuers : k => url if !contains(keys(var.existing_oidc_provider_arns), url) }
  oidc_arns = { for k, url in local.issuers :
    k => lookup(var.existing_oidc_provider_arns, url, try(aws_iam_openid_connect_provider.k8s[k].arn, null))
  }
}

# ---------------------------------------------------------------- GCP

resource "google_project_service" "svc" {
  for_each           = toset(["secretmanager.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com"])
  project            = var.gcp_project_id
  service            = each.key
  disable_on_destroy = false
}

resource "google_iam_workload_identity_pool" "k8s" {
  count                     = length(local.all_eks) > 0 ? 1 : 0
  project                   = var.gcp_project_id
  workload_identity_pool_id = local.pool_id
  display_name              = "DAAS Kubernetes clusters"
  depends_on                = [google_project_service.svc]
}

resource "google_iam_workload_identity_pool_provider" "eks" {
  for_each                           = { for c in local.all_eks : c.name => c }
  project                            = var.gcp_project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.k8s[0].workload_identity_pool_id
  workload_identity_pool_provider_id = each.key # DAAS keeps EKS cluster names <= 32 chars
  attribute_mapping                  = { "google.subject" = "assertion.sub" }
  oidc {
    issuer_uri        = each.value.oidc_issuer
    allowed_audiences = [local.token_aud]
  }
}

resource "google_service_account" "team" {
  for_each     = local.active
  project      = var.gcp_project_id
  account_id   = "${local.cv.gcpReaderPrefix}${each.key}"
  display_name = "DAAS secrets reader: ${each.key} (${var.stage})"
}

resource "google_project_iam_member" "team_read" {
  for_each = local.active
  project  = var.gcp_project_id
  role     = "roles/secretmanager.secretAccessor"
  member   = "serviceAccount:${google_service_account.team[each.key].email}"
  condition {
    title      = "${each.key}-secrets-prefix"
    expression = "resource.name.startsWith(\"projects/${var.gcp_project_number}/secrets/${each.key}${local.cv.secretKeySeparator}\")"
  }
}

locals {
  wi_members = flatten([
    for t in values(local.active) : [
      for ns in t.namespaces : concat(
        [for p in distinct([for c in t.gke : c.project]) : { team = t.name, member = "serviceAccount:${p}.svc.id.goog[${ns}/${local.ksa}]" }],
        length(t.eks) == 0 ? [] : [{
          team   = t.name
          member = "principal://iam.googleapis.com/projects/${var.gcp_project_number}/locations/global/workloadIdentityPools/${local.pool_id}/subject/system:serviceaccount:${ns}:${local.ksa}"
        }]
      )
    ]
  ])
}

resource "google_service_account_iam_member" "wi" {
  for_each           = { for m in local.wi_members : "${m.team}|${m.member}" => m }
  service_account_id = google_service_account.team[each.value.team].name
  role               = "roles/iam.workloadIdentityUser"
  member             = each.value.member
}

# DAAS creates secrets, adds versions and checks they exist, but can never read a value
# (no secretmanager.versions.access), matching the AWS writer role (no GetSecretValue).
resource "google_project_iam_custom_role" "daas_writer" {
  project     = var.gcp_project_id
  role_id     = "daasSecretsWriter"
  title       = "DAAS secrets writer (no read)"
  permissions = [
    "secretmanager.secrets.create", "secretmanager.secrets.get", "secretmanager.secrets.list",
    "secretmanager.secrets.update", "secretmanager.secrets.delete",
    "secretmanager.versions.add", "secretmanager.versions.get", "secretmanager.versions.list",
  ]
  depends_on = [google_project_service.svc]
}

resource "google_project_iam_member" "daas_writer" {
  project = var.gcp_project_id
  role    = google_project_iam_custom_role.daas_writer.id
  member  = var.daas_gcp_writer_member
}

# ---------------------------------------------------------------- AWS

data "aws_caller_identity" "this" {}

resource "aws_iam_openid_connect_provider" "k8s" {
  for_each       = local.issuers_to_create
  url            = each.value
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "team_trust" {
  for_each = local.active
  dynamic "statement" {
    for_each = local.team_issuers[each.key] # only this team's own clusters
    content {
      effect  = "Allow"
      actions = ["sts:AssumeRoleWithWebIdentity"]
      principals {
        type        = "Federated"
        identifiers = [local.oidc_arns[statement.key]]
      }
      condition {
        test     = "StringEquals"
        variable = "${trimprefix(statement.value, "https://")}:aud"
        values   = ["sts.amazonaws.com"]
      }
      condition {
        test     = "StringEquals"
        variable = "${trimprefix(statement.value, "https://")}:sub"
        values   = [for ns in each.value.namespaces : "system:serviceaccount:${ns}:${local.ksa}"]
      }
    }
  }
}

resource "aws_iam_role" "team" {
  for_each           = local.active
  name               = "${local.cv.awsReaderRolePrefix}${each.key}"
  assume_role_policy = data.aws_iam_policy_document.team_trust[each.key].json
}

resource "aws_iam_role_policy" "team_read" {
  for_each = local.active
  name     = "read-own-prefix"
  role     = aws_iam_role.team[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = "arn:aws:secretsmanager:*:${data.aws_caller_identity.this.account_id}:secret:${each.key}${local.cv.secretKeySeparator}*"
    }]
  })
}

resource "aws_iam_role" "writer" {
  name = local.cv.awsWriterRole
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { AWS = var.daas_aws_principal_arn }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "writer" {
  name = "manage-daas-secrets"
  role = aws_iam_role.writer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret",
        "secretsmanager:DeleteSecret", "secretsmanager:RestoreSecret", "secretsmanager:TagResource"]
        Resource = "arn:aws:secretsmanager:*:${data.aws_caller_identity.this.account_id}:secret:*${local.cv.secretKeySeparator}*"
      },
      { Effect = "Allow", Action = "secretsmanager:ListSecrets", Resource = "*" },
    ]
  })
}
