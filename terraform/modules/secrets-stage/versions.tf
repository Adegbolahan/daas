# Versions are pinned by the root (generated from platform/daas.yaml `terraform.providers`).
terraform {
  required_providers {
    google = { source = "hashicorp/google" }
    aws    = { source = "hashicorp/aws" }
  }
}
