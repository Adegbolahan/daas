variable "stage" {
  description = "Stage this module manages (from platform/stages.yaml)"
  type        = string
}

variable "gcp_project_id" {
  description = "Dedicated GCP project holding this stage's DAAS secrets"
  type        = string
}

variable "gcp_project_number" {
  type = string
}

variable "teams" {
  description = "Teams enabled for this stage, their namespaces here, and their dedicated clusters in this stage"
  type = list(object({
    name       = string
    namespaces = list(string)
    gke = list(object({
      name     = string
      project  = string
      location = string
    }))
    eks = list(object({
      name        = string
      oidc_issuer = string
    }))
  }))
}

variable "existing_oidc_provider_arns" {
  description = "Issuer URL => ARN for IAM OIDC providers that already exist in this AWS account (e.g. created by the EKS module). Those are reused instead of created."
  type        = map(string)
  default     = {}
}

variable "daas_gcp_writer_member" {
  description = "IAM member DAAS runs as in GCP, e.g. serviceAccount:daas-api@acme-platform.iam.gserviceaccount.com"
  type        = string
}

variable "daas_aws_principal_arn" {
  description = "IAM role DAAS runs as in AWS; it may assume the writer role in this account"
  type        = string
}

variable "conventions" {
  description = "Naming conventions from platform/conventions.yaml (shared with the DAAS API)"
  type = object({
    secretKeySeparator    = string
    secretsServiceAccount = string
    gcpReaderPrefix       = string
    awsReaderRolePrefix   = string
    awsWriterRole         = string
    wifPool               = string
    wifTokenAudience      = string
  })
}
