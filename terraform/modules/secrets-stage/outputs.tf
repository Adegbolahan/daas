output "team_gsa_emails" {
  value = { for k, sa in google_service_account.team : k => sa.email }
}

output "team_aws_role_arns" {
  value = { for k, r in aws_iam_role.team : k => r.arn }
}

output "writer_role_arn" {
  value = aws_iam_role.writer.arn
}
