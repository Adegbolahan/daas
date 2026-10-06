# Team `orders`

_Generated from this folder and the platform files by `python -m daas_api.team --write`. Edit `access.yaml`, `clusters.yaml` or `secrets.yaml`, not this file._

## Access

- **Folder owners:** @acme/orders-leads (plus the platform team)
- **GitLab projects that can deploy:** `acme/orders/*`
- **Argo CD project:** `orders`. It can only touch this team's namespaces on this team's clusters. No cluster-scoped objects, quotas, RBAC, NetworkPolicies or SecretStores
- **Read-only kubectl:** group `team-orders`
- **Pod Security Standard:** `restricted` on every namespace, plus a default-deny ingress NetworkPolicy (same namespace, the cluster Gateway, and namespaces labelled `daas/allow-ingress=true` are allowed)
- **Hosts apps may claim:** none. Apps get only the default `<app>.<cluster domain>`
- **Deploy notifications:** global webhooks only

## Stages

### preview

- **GitLab environments:** `review/*` (jobs declare `deployment_tier: development`)
- **Gates:** none
- **Namespace:** `orders-preview`
- **Clusters:**
  - `orders-gke-usc1-preview` (gke, us-central1), no public ingress
- **Secrets:** written by Entra role `orders.secrets`; stored in GCP `acme-secrets-preview` / AWS `333333333333` (us-east-1)
  - read as GCP `daas-sec-orders@acme-secrets-preview.iam.gserviceaccount.com` and AWS `arn:aws:iam::333333333333:role/daas-secrets-orders`
- **Previews:** URL `https://<app>-mr-<iid>.orders.preview.example.com`, up to 3 at once, quota 2 CPU / 4Gi; removed on MR merge/close, or after DAAS_PREVIEW_TTL_HOURS without a push

### qa

- **GitLab environments:** `qa`, `qa-*` (jobs declare `deployment_tier: testing`)
- **Gates:** none
- **Namespace:** `orders`
- **Clusters:**
  - `orders-gke-usc1-qa` (gke, us-central1), no public ingress
- **Secrets:** written by Entra role `orders.secrets`; stored in GCP `acme-secrets-qa` / AWS `444444444444` (us-east-1)
  - read as GCP `daas-sec-orders@acme-secrets-qa.iam.gserviceaccount.com` and AWS `arn:aws:iam::444444444444:role/daas-secrets-orders`

### staging

- **GitLab environments:** `staging` (jobs declare `deployment_tier: staging`)
- **Gates:** none
- **Namespace:** `orders`
- **Clusters:**
  - `orders-eks-use1-stage` (eks, us-east-1), no public ingress
  - `orders-gke-usc1-stage` (gke, us-central1), no public ingress
- **Secrets:** written by Entra role `orders.secrets`; stored in GCP `acme-secrets-stg` / AWS `222222222222` (us-east-1)
  - read as GCP `daas-sec-orders@acme-secrets-stg.iam.gserviceaccount.com` and AWS `arn:aws:iam::222222222222:role/daas-secrets-orders`

### production

- **GitLab environments:** `production`, `production-*` (jobs declare `deployment_tier: production`)
- **Gates:** protected branch, protected environment + approvals
- **Namespace:** `orders`
- **Clusters:**
  - `orders-eks-use1-prod` (eks, us-east-1), no public ingress
  - `orders-gke-usc1-prod` (gke, us-central1), no public ingress
- **Secrets:** written by Entra role `orders.secrets.prod`; stored in GCP `acme-secrets-prod` / AWS `111111111111` (us-east-1)
  - read as GCP `daas-sec-orders@acme-secrets-prod.iam.gserviceaccount.com` and AWS `arn:aws:iam::111111111111:role/daas-secrets-orders`

## Secrets

- **Default provider:** `aws` (override per secret in an app's daas.yaml with `from:`)
- **Key format:** `orders_<app>_<NAME>`. This team's identities can read only keys that start with `orders_`
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
