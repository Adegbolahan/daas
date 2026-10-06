output "stage" {
  value = local.stage
}

output "team_gsa_emails" {
  value = module.secrets.team_gsa_emails
}

output "team_aws_role_arns" {
  value = module.secrets.team_aws_role_arns
}

output "writer_role_arn" {
  value = module.secrets.writer_role_arn
}
