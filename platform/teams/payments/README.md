# Team `payments`

_Generated from this folder and the platform files by `python -m daas_api.team --write`. Edit `access.yaml`, `clusters.yaml` or `secrets.yaml`, not this file._

## Access

- **Folder owners:** @acme/payments-leads (plus the platform team)
- **GitLab projects that can deploy:** `acme/payments/*`
- **Argo CD project:** `payments`. It can only touch this team's namespaces on this team's clusters. No cluster-scoped objects, quotas, RBAC, NetworkPolicies or SecretStores
- **Read-only kubectl:** group `team-payments`
- **Pod Security Standard:** `restricted` on every namespace, plus a default-deny ingress NetworkPolicy (same namespace, the cluster Gateway, and namespaces labelled `daas/allow-ingress=true` are allowed)
- **Hosts apps may claim** (`ingress.hosts`): `*.payments.example.com`, `pay.example.com`
- **Deploy notifications:** the webhook in DAAS env var `DAAS_NOTIFY_PAYMENTS`

## Stages

### preview

- **GitLab environments:** `review/*` (jobs declare `deployment_tier: development`)
- **Gates:** none
- **Namespace:** `payments-preview`
- **Clusters:**
  - `payments-gke-usc1-preview` (gke, us-central1), no public ingress
- **Secrets:** written by Entra role `payments.secrets`; stored in GCP `acme-secrets-preview` / AWS `333333333333` (us-east-1)
  - read as GCP `daas-sec-payments@acme-secrets-preview.iam.gserviceaccount.com` and AWS `arn:aws:iam::333333333333:role/daas-secrets-payments`
- **Previews:** URL `https://<app>-mr-<iid>.payments.preview.example.com`, up to 5 at once, quota 4 CPU / 8Gi; removed on MR merge/close, or after DAAS_PREVIEW_TTL_HOURS without a push

### qa

- **GitLab environments:** `qa`, `qa-*` (jobs declare `deployment_tier: testing`)
- **Gates:** none
- **Namespace:** `payments`
- **Clusters:**
  - `payments-gke-usc1-qa` (gke, us-central1), no public ingress
- **Secrets:** written by Entra role `payments.secrets`; stored in GCP `acme-secrets-qa` / AWS `444444444444` (us-east-1)
  - read as GCP `daas-sec-payments@acme-secrets-qa.iam.gserviceaccount.com` and AWS `arn:aws:iam::444444444444:role/daas-secrets-payments`

### uat

- **GitLab environments:** `uat` (jobs declare `deployment_tier: testing`)
- **Gates:** none
- **Namespace:** `payments`
- **Clusters:**
  - `payments-eks-use1-uat` (eks, us-east-1), no public ingress
- **Secrets:** written by Entra role `payments.secrets`; stored in GCP `acme-secrets-uat` / AWS `555555555555` (us-east-1)
  - read as GCP `daas-sec-payments@acme-secrets-uat.iam.gserviceaccount.com` and AWS `arn:aws:iam::555555555555:role/daas-secrets-payments`

### perf

- **GitLab environments:** `perf` (jobs declare `deployment_tier: testing`)
- **Gates:** none
- **Namespace:** `payments`
- **Clusters:**
  - `payments-gke-usc1-perf` (gke, us-central1), no public ingress
- **Secrets:** written by Entra role `payments.secrets`; stored in GCP `acme-secrets-perf` / AWS `666666666666` (us-east-1)
  - read as GCP `daas-sec-payments@acme-secrets-perf.iam.gserviceaccount.com` and AWS `arn:aws:iam::666666666666:role/daas-secrets-payments`

### staging

- **GitLab environments:** `staging` (jobs declare `deployment_tier: staging`)
- **Gates:** none
- **Namespace:** `payments`
- **Clusters:**
  - `payments-gke-usc1-stage` (gke, us-central1), public apps at `<app>.stg.payments.example.com`
  - `payments-eks-use1-stage` (eks, us-east-1), public apps at `<app>.stg.payments.example.com`
- **Secrets:** written by Entra role `payments.secrets`; stored in GCP `acme-secrets-stg` / AWS `222222222222` (us-east-1)
  - read as GCP `daas-sec-payments@acme-secrets-stg.iam.gserviceaccount.com` and AWS `arn:aws:iam::222222222222:role/daas-secrets-payments`

### production

- **GitLab environments:** `production`, `production-*` (jobs declare `deployment_tier: production`)
- **Gates:** protected branch, protected environment + approvals
- **Namespace:** `payments`
- **Clusters:**
  - `payments-gke-usc1-prod` (gke, us-central1), public apps at `<app>.payments.example.com`, prometheus-operator
  - `payments-gke-euw1-prod` (gke, europe-west1), public apps at `<app>.payments.example.com`, prometheus-operator
  - `payments-eks-use1-prod` (eks, us-east-1), public apps at `<app>.payments.example.com`, prometheus-operator
  - `payments-eks-euw1-prod` (eks, eu-west-1), public apps at `<app>.payments.example.com`, prometheus-operator
- **Secrets:** written by Entra role `payments.secrets.prod`; stored in GCP `acme-secrets-prod` / AWS `111111111111` (us-east-1)
  - read as GCP `daas-sec-payments@acme-secrets-prod.iam.gserviceaccount.com` and AWS `arn:aws:iam::111111111111:role/daas-secrets-payments`

## Secrets

- **Default provider:** `gcp` (override per secret in an app's daas.yaml with `from:`)
- **Key format:** `payments_<app>_<NAME>`. This team's identities can read only keys that start with `payments_`
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
