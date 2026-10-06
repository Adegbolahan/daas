# Team `web`

_Generated from this folder and the platform files by `python -m daas_api.team --write`. Edit `access.yaml`, `clusters.yaml` or `secrets.yaml`, not this file._

## Access

- **Folder owners:** @acme/web-leads (plus the platform team)
- **GitLab projects that can deploy:** `acme/web/*`, `acme/storefront`
- **Argo CD project:** `web`. It can only touch this team's namespaces on this team's clusters. No cluster-scoped objects, quotas, RBAC, NetworkPolicies or SecretStores
- **Read-only kubectl:** group `team-web`
- **Pod Security Standard:** `restricted` on every namespace, plus a default-deny ingress NetworkPolicy (same namespace, the cluster Gateway, and namespaces labelled `daas/allow-ingress=true` are allowed)
- **Hosts apps may claim:** none. Apps get only the default `<app>.<cluster domain>`
- **Deploy notifications:** global webhooks only

## Stages

### staging

- **GitLab environments:** `staging` (jobs declare `deployment_tier: staging`)
- **Gates:** none
- **Namespace:** `web`
- **Clusters:**
  - `web-eks-use1-stage` (eks, us-east-1), no public ingress
- **Secrets:** written by Entra role `web.secrets`; stored in GCP `acme-secrets-stg` / AWS `222222222222` (us-east-1)
  - read as GCP `daas-sec-web@acme-secrets-stg.iam.gserviceaccount.com` and AWS `arn:aws:iam::222222222222:role/daas-secrets-web`

## Secrets

- **Default provider:** `aws` (override per secret in an app's daas.yaml with `from:`)
- **Key format:** `web_<app>_<NAME>`. This team's identities can read only keys that start with `web_`
- **In every namespace:** ServiceAccount `daas-secrets`, SecretStores `daas-gcp` and `daas-aws`

## Every app gets

- Deployment (zone-spread, maxUnavailable 0), or a CronJob when daas.yaml has `schedule`
- ServiceAccount <app>, annotated from `identity` (GKE Workload Identity / EKS IRSA)
- HorizontalPodAutoscaler, and a PodDisruptionBudget when scaling.min > 1
- Service :80 when the app has a port
- HTTPRoute on the cluster Gateway for `ingress` (and for every preview)
- ExternalSecret per provider -> Secret <app>-secrets-<gcp|aws>, injected as env; pods restart on rotation (Reloader)
- imagePullSecret for the platform registry
- ServiceMonitor/PodMonitor for `metrics`, and availability/crash-loop alerts, where prometheus-operator runs
