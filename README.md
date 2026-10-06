# DAAS — Deployment as a Service

Apps declare everything in one file, `daas.yaml`: image, port, env, resources, health checks,
scaling, secrets, and target regions. A GitLab CI/CD component sends it to the DAAS API, which
validates it, authorizes the caller, renders Kubernetes manifests for the team's clusters, and
rolls them out region by region through GitOps (Argo CD) to GKE and EKS. Every merge request can
also get its own preview environment.

```
app repo                GitLab component            DAAS API                        GitOps repo           Argo CD (hub)
                        build payload               validate daas.yaml              clusters/             ─▶ payments-gke-usc1-prod
daas.yaml   ──────────▶ OIDC id_token  ───────────▶ env → stage, project → team ──▶ <cluster>/<ns>/<app>/ ─▶ payments-eks-use1-prod
                        POST, then poll status      render per cluster, waves       manifests + daas.json ─▶ orders-gke-usc1-qa …
```

## Layout

| path | what | owned by |
|---|---|---|
| `platform/stages.yaml` | stages (any number): environment routing, GitLab tier, secrets project/account per stage | platform |
| `platform/conventions.yaml` | naming conventions shared by the API and Terraform | platform |
| `platform/service.yaml` | the DAAS service: GitOps repo, its identities, platform owners | platform |
| `platform/terraform.yaml` | Terraform versions, state, pipeline identities | platform |
| `platform/teams/<team>/` | one folder per team: `access.yaml`, `clusters.yaml`, `secrets.yaml`, generated `README.md` | the team + platform |
| `platform/argocd/README.md` | the one-time Argo CD bootstrap | platform |
| `.gitlab/CODEOWNERS` | generated: team folders need the team's owners **and** the platform team | platform |
| `api/` | FastAPI service: validate → authorize → render → commit → wait for health | platform |
| `terraform/` | cross-cloud secret access, one state per stage, driven by `platform/` | platform |
| `gitlab-component/templates/` | `deploy.yml` (named environment), `review.yml` (preview per MR) | platform |
| `spec/daas.schema.json` | JSON Schema for an app's `daas.yaml` | platform |
| `.gitlab-ci.yml` | DAAS's own pipeline: tests, plan every stage on MRs, apply stages in order on main | platform |
| `bin/daas-secret` | CLI for humans to set, list and delete secrets (Entra ID login) | everyone |
| `backstage/` | Backstage plugins: DAAS UI, schema-driven create/update/onboard templates (see `backstage/README.md`) | platform |
| `examples/payments-api/`, `examples/orders-api/` | sample app repos (`daas.yaml`, CI, and for orders a Dockerfile + tiny service) | app teams |

## Stages

A **stage** is an isolated environment: its own secrets project/account, its own Terraform state,
and each team's dedicated clusters in it. Add as many as you need in `platform/stages.yaml`.

```yaml
qa:
  gitlabTier: testing              # the GitLab tier jobs must declare (gates, protected environments)
  environments: ["qa", "qa-*"]     # GitLab environment names routed here (globs; first match wins)
  partialTargets: true             # deploy to the app's regions that exist here, skip the rest
  gcp: { project: acme-secrets-qa, projectNumber: "100000000004" }
  aws: { account: "444444444444", region: us-east-1 }
```

- **More stages than GitLab tiers:** GitLab has five tiers; stages aren't limited. The example has
  six stages (`preview`, `qa`, `uat`, `perf`, `staging` and `production`), and qa, uat and perf
  all share the `testing` tier but are fully isolated from each other.
- **Routing:** a deploy's GitLab environment name picks the stage. `production-eu` → production,
  `qa-2` → qa, `review/mr-42` → preview. The job must declare the stage's `gitlabTier`. DAAS reads
  both from the job's token, not the request.
- **`partialTargets`:** an app lists its production regions once. In stages marked this way, it
  lands in whichever of those regions the team has a cluster for, and the response reports the
  rest as `skippedTargets`. Production requires every target.
- **Adding a stage:** add it to `stages.yaml`, then add it to the teams' `access.yaml` and their
  clusters' `clusters.yaml`. The pipeline creates its Terraform state and identities, and DAAS
  renders its namespaces.

## Teams

Each team has a folder in the platform repo, added through a merge request:

```
platform/teams/payments/
  access.yaml     namespace, IdP group, folder owners, GitLab projects, enabled stages + gates,
                  preview limits, ingress domains, pod security level, notification webhook
  clusters.yaml   the team's dedicated clusters (name, stage, cloud, region, gcpProject | oidcIssuer,
                  gateway + domain for public apps, features such as prometheus-operator)
  secrets.yaml    default provider (gcp | aws) and the Entra roles that may write secrets, per stage
  README.md       generated: everything the folder gives the team
```

- **`access.yaml` vs an app's `daas.yaml`:** `daas.yaml` describes one workload and lives in the
  app repo, which the team edits freely. `access.yaml` grants access and sets gates for all of the
  team's apps: which repos may deploy, which stages, whether production needs approvals. It lives
  here, behind platform-team review, so a team can't approve itself.
- **Clusters are dedicated.** A team only ever deploys to clusters in its own `clusters.yaml`.
  Names must start with `<team>-` because Argo CD cluster names are global. Its Argo CD project
  can only reach those clusters, and its AWS reader role trusts only those clusters' identity
  issuers.
- **Ownership:** `.gitlab/CODEOWNERS` is generated. A change to `platform/teams/payments/` needs
  approval from the folder's `owners` and from the platform team.
- **Generated files:** after changing anything under `platform/`, run
  `cd api && python -m daas_api.team --write`. It updates each team's `README.md` and
  `CODEOWNERS`, and CI fails if they're out of date.

What a team gets, per stage it enables:

- **Deploy rights:** its GitLab projects can deploy, behind that stage's gates (protected branch,
  protected environment with approvals).
- **A namespace on each of its clusters** (`<team>-preview` in the preview stage), with
  read-only kubectl for the team's group. Every namespace enforces the team's Pod Security
  Standard (`restricted` by default), has a LimitRange, and has a default-deny ingress
  NetworkPolicy. Traffic is allowed from the same namespace, the cluster's Gateway, and
  namespaces labelled `daas/allow-ingress=true`.
- **An imagePullSecret** for the platform registry, synced from the team secret
  `<team>_daas_REGISTRY_AUTH` (see [Registry](#registry)).
- **Secrets:**
  - a reader identity in each cloud (a GCP service account and an AWS role), limited to
    `<team>_*` keys;
  - SecretStores for both clouds in every namespace;
  - Entra roles that can write the values.
- **Previews:** a URL per MR on the team's preview cluster, with a quota and a cap on concurrent
  previews.

`platform/teams/orders/README.md` shows the output. `python -m daas_api.team orders` prints it.

## The app contract (`daas.yaml`)

```yaml
apiVersion: daas/v1
name: payments-api
port: 8080                      # omit for workers; with `schedule` it's a CronJob
# schedule: "0 3 * * *"         # scheduled job instead of a long-running service
# image: nginx:1.27             # optional; omit to use the image CI built
env: { LOG_LEVEL: info }
resources: { cpu: 500m, memory: 512Mi }
health: { liveness: /healthz, readiness: /ready }
scaling: { min: 2, max: 10, targetCPU: 70 }
secrets:                        # names only; values are set per stage with daas-secret
  - DB_URL                      # team's default provider
  - { name: STRIPE_KEY, from: aws }
ingress: {}                     # public at <app>.<cluster domain>; or { hosts: [pay.example.com] }
metrics: { path: /metrics }     # scrape annotations; ServiceMonitor + alerts on prometheus-operator clusters
identity:                       # the app's own cloud access (IAM bindings live in the team's Terraform)
  gcpServiceAccount: payments-api@acme-payments-prod.iam.gserviceaccount.com
  awsRoleArn: arn:aws:iam::111111111111:role/payments-api
targets:
  - { provider: gke, region: us-central1 }   # first = canary
  - { provider: eks, region: us-east-1 }
rollout: { strategy: sequential }            # or parallel
stages:                         # per-stage overrides
  qa: { env: { LOG_LEVEL: debug }, scaling: { min: 1, max: 2 } }
  production: { ingress: { hosts: [pay.example.com] } }
```

- **Kinds of app:** with `port` it's a service (Deployment, Service, HPA, PDB). Without `port`
  it's a worker (Deployment and HPA, no Service). With `schedule` it's a CronJob.
- **Per-stage overrides:** under `stages.<stage>`, `env`, `scaling` and `resources` merge over
  the base, while `identity`, `ingress` and `targets` replace it. Set `ingress: null` to keep a
  stage private.
- **`ingress`:** the app gets an HTTPRoute on each cluster's Gateway (`gateway` + `domain` in
  `clusters.yaml`). The default host is `<app>.<domain>`. Explicit `hosts` must match the team's
  `domains` in `access.yaml`, so one team can't claim another's hostname. Use the same domain
  across regions and let DNS route between them (external-dns with latency or geo records).
  - Production refuses a cluster without a gateway.
  - `partialTargets` stages deploy there without a public route and return a warning.
- **`identity`:** the app's own cloud access. This annotates its ServiceAccount: GKE Workload
  Identity on GKE, IRSA on EKS. Grant the IAM in the team's Terraform, trusting
  `<namespace>/<app>`. Different accounts per stage go under `stages.<stage>.identity`.
- **Validation:** the full schema is in `spec/daas.schema.json`. Unknown fields and unknown stage
  names are rejected, so typos fail fast in CI. The app name `daas` is reserved.

## How a deploy works

1. The CI job runs with a GitLab `environment` (name + `deployment_tier`) and a
   `resource_group`, so only one deploy per environment runs at a time. It sends `daas.yaml`, the
   CI image and the environment name to `POST /v1/deployments`, authenticated with the job's
   GitLab OIDC `id_token`.
2. DAAS verifies the token, routes the environment to a stage, maps the project to a team and
   applies the permission checks below.
3. Targets resolve to the team's clusters in that stage. A missing region gets a 403 listing the
   regions available, unless the stage has `partialTargets`.
4. Secrets and registry credentials must already be set for that stage, or the deploy is refused
   with the list of what's missing.
5. Manifests are rendered per cluster and committed to the GitOps repo one wave at a time. DAAS
   calls Argo CD's webhook so it syncs right away, then waits for Argo CD to report `Synced` +
   `Healthy` on a revision that includes that commit. Other apps' deploys moving the repo ahead
   don't matter. An unhealthy wave stops the rollout, so later regions are never touched.
6. The component polls `GET /v1/deployments/{id}` and passes or fails the pipeline. Chat
   webhooks get the result (see [Operations](#operations)).

## Permissions

| layer | control | where |
|---|---|---|
| Who can call | GitLab OIDC token (issuer, audience, signature) | `auth.py` |
| Which environment + stage | The token's `environment` claim must equal the request. It routes to a stage, and the token's `deployment_tier` must equal that stage's `gitlabTier` | `policy.authorize` |
| Which team | `project_path` glob → team (`access.yaml` `projects`); the team must enable the stage | `platform/teams/` |
| Which clusters | Only the team's own clusters (`clusters.yaml`) | `platform/teams/` |
| Stage gates | `protectedRefOnly` → `ref_protected` claim; `requireProtectedEnvironment` → `environment_protected` claim. Protect the tier once at group level. GitLab enforces approvals and allowed deployers before the job starts | GitLab + `access.yaml` |
| Changing a team's config | CODEOWNERS: the team's owners plus the platform team | `.gitlab/CODEOWNERS` (generated) |
| One environment per cluster slot | Two environments can't both deploy the same app to the same cluster (409) | `main.py` |
| App ownership | An app name belongs to the project that first deployed it (recorded in `daas.json`). Other projects get a 409 when they deploy it and a 404 when they try to delete it | `main.py` |
| DAAS itself | No cluster credentials. It only writes to the GitOps repo | deploy token on that repo |
| Argo CD | One AppProject per team: only its namespaces on its clusters, nothing cluster-scoped, no quotas/limits/RBAC/NetworkPolicies/SecretStores | rendered into the GitOps repo |
| Workloads | Pod Security Admission (team `podSecurity`, default `restricted`), dropped capabilities, no privilege escalation, seccomp RuntimeDefault, default-deny ingress NetworkPolicy | rendered |
| Hostnames | `ingress.hosts` must match the team's `domains` | `access.yaml` |
| Stopping environments | Only previews (or stages with `allowStop: true`) can be deleted through a GitLab stop job, so stopping `production` in GitLab can't delete production | `stages.yaml` |
| Team matching | A project that matches two teams' `projects` is refused, and identical patterns are rejected on load | `access.yaml` |
| Stage isolation | Each stage must have its own GCP project and AWS account (enforced on load) | `stages.yaml` |
| Humans | The team's group gets the `view` ClusterRole on its namespaces. All changes go through DAAS | generated RoleBindings |
| Secrets (read) | Per-team identities can read only `<team>_*` in the stage's project/account, and only from the team's clusters. Apps can't pick keys or stores | see [Secrets](#secrets) |
| Secrets (write) | Entra ID role per team and stage (`secrets.yaml` `writers`). Write-only API with an audit log. DAAS itself can write but never read values (GCP custom role without `versions.access`; AWS role without `GetSecretValue`) | see [Secrets](#secrets) |
| Cloud IAM | `identity` in `daas.yaml` annotates the app's ServiceAccount `<namespace>/<app>`. The IAM itself lives in the team's Terraform | team Terraform |

Platform objects (AppProjects, namespaces, preview quotas, RoleBindings, secret stores and the
Argo CD ApplicationSets) are generated from `platform/` and committed to the GitOps repo when the
API starts. The only object you apply by hand is the bootstrap Application
(`platform/argocd/README.md`).
You can also generate them manually with `python -m daas_api.platform_render`.

## Preview environments

Include the review component and every MR gets `https://<app>-mr-<iid>.<team's previewDomain>`:

```yaml
include:
  - component: $CI_SERVER_FQDN/platform/daas-deploy/review@1.0.0
    inputs: { api_url: https://daas.example.com }
```

- **Stage:** environments routed to the stage marked `preview: true` (`review/*` in the example)
  are previews. The team needs that stage in `access.yaml`, plus one cluster in it in
  `clusters.yaml`.
- **Placement:** the app goes to the team's preview cluster, and `targets` and `rollout` are
  ignored. It's named `payments-api-mr-42` in namespace `payments-preview`.
- **Size:** 1 replica, no HPA or PDB. The namespace has a ResourceQuota, and there's a cap on
  concurrent previews per team (`preview.maxConcurrent`, default 5).
- **URL:** an HTTPRoute on the preview cluster's Gateway (`previewDomain` + `gateway` in
  `clusters.yaml`). This needs wildcard DNS for the domain pointing at the Gateway.
- **Secrets:** the same key names, read from the preview stage's own project/account. Previews
  never read production secrets.
- **Cleanup:** the GitLab stop job calls `DELETE /v1/environments/review/mr-42` when the MR is
  merged or closed, and `auto_stop_in` (3 days) covers forgotten ones. The DAAS reaper also
  removes previews past their `expiresAt` (`DAAS_PREVIEW_TTL_HOURS`, refreshed on every push),
  which covers MRs whose stop job never ran. Removing the directory deletes the Argo Application
  and its resources (resources finalizer).

## Secrets

A secret belongs to a **stage + team + app**, not to a cluster. Each stage has its own GCP
project and AWS account (`platform/stages.yaml`), and an app on any cluster can read from either.

```
key: <team>_<app>_<NAME>      e.g. payments_payments-api_DB_URL   (valid in both clouds)
```

**Where a secret lives.** The team default comes from `platform/teams/<team>/secrets.yaml`
(`provider`), and the app's `daas.yaml` can override it per secret with `{ name: X, from: aws }`.

**Setting values (humans, Entra ID).**

```bash
echo -n 'postgres://…' | bin/daas-secret set production payments payments-api DB_URL
bin/daas-secret set staging payments payments-api STRIPE_KEY aws < key.txt
bin/daas-secret list production payments payments-api      # names + updated times, never values
```

- The caller needs the Entra app role (or group) in the team's `secrets.yaml` `writers`, for example
  `payments.secrets.prod` for production and `payments.secrets` for everything else.
- The API is write-only. It stores values and returns metadata, and every change is logged as
  JSON (`daas.audit`: user, action, stage, key, provider), never with the value.
- DAAS writes with its own identity: a custom `daasSecretsWriter` role on each stage's project,
  and `daas-secrets-writer` in each stage's account. Neither can read a value back.
- AWS deletes are recoverable for 7 days. GCP deletes are immediate.

**Reading values (apps, via External Secrets Operator).** In the team's namespace on each of its
clusters, the platform renders a `daas-secrets` ServiceAccount and two SecretStores, `daas-gcp` and
`daas-aws`, pointing at that cluster's stage project and account:

| app runs on | → GCP Secret Manager | → AWS Secrets Manager |
|---|---|---|
| GKE | GKE Workload Identity → team GSA `daas-sec-<team>` | web identity: the stage's account trusts the team's GKE issuers → role `daas-secrets-<team>` |
| EKS | Workload Identity Federation (pool `daas-k8s`, provider per EKS cluster) → same GSA | web identity: the stage's account trusts the team's EKS issuers → same role |

- There are no static keys anywhere.
- The team identities can read only `<team>_*`, enforced by an IAM condition in GCP and a
  resource ARN prefix in AWS.
- The External Secrets controller itself holds no cloud permissions.
- Teams can't create their own SecretStores: they're blacklisted in the team's AppProject.
- Previews use the same key names from the preview stage's project/account, so they never see
  production values.

**Deploys check secrets first.** If any secret in `daas.yaml` isn't set for the target stage, the
deploy fails with a 422 listing the missing ones and the command to set them, instead of hanging
on a Secret that never syncs. Turn this off with `DAAS_CHECK_SECRETS=false`.

**Wiring it up.**

1. In `platform/stages.yaml`, fill in each stage's `gcp`/`aws`. In each team's `clusters.yaml`,
   give every cluster `gcpProject` (GKE) or `oidcIssuer` (EKS); the cloud cluster name must match
   its `name`.
2. Merge. The DAAS pipeline runs Terraform for every stage (see [Terraform](#terraform)).
3. In Entra ID:
   - Register an app for DAAS (Application ID URI `api://daas`) and set
     `accessTokenAcceptedVersion: 2`.
   - Create app roles such as `payments.secrets` and `payments.secrets.prod`, and assign them to
     groups.
   - Pre-authorize the Azure CLI (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) so
     `az account get-access-token --scope api://daas/.default` works.
   - Set `DAAS_ENTRA_TENANT_ID` and `DAAS_ENTRA_AUDIENCE` (the app's client ID or `api://daas`).
4. Install External Secrets Operator (v0.16+ for `external-secrets.io/v1` and GCP WIF) on every
   cluster.

**Rotation.** ExternalSecrets refresh hourly, but env vars only change when pods restart. Restart
the deployment after rotating, or add a reloader such as stakater/Reloader if you want that
automated.

## Terraform

`terraform/live` manages cross-cloud secret access **for one stage per workspace**, with a
separate state per stage. It reads everything from `platform/`: stages, conventions, service
identities, and every team folder with its clusters. Adding a stage, team or cluster is a YAML
change.

- **Why a generated file:** Terraform only accepts literals in the `terraform {}` block (versions,
  providers, backend). `terraform/daas_tf.py config` generates it from `platform/terraform.yaml`
  as `live/_config.tf.json`, which is gitignored.
- **DAAS runs it** (`.gitlab-ci.yml`). Changing `platform/` or `terraform/` triggers a child
  pipeline generated by `terraform/daas_tf.py pipeline`:
  - **On MRs:** `plan:<stage>` for every stage, using read-only identities. The plan text is an
    artifact, and GitLab's Terraform MR widget shows create/update/delete counts.
  - **On the default branch:** `apply:<stage>` applies the reviewed plan in `stages.yaml` order,
    each waiting for the previous stage. Stages with `autoApply: false` (production in the
    example) wait for a click. A stale plan fails instead of applying something nobody reviewed.
  - `resource_group: daas-terraform-<stage>` prevents concurrent runs against one stage's state.
  - Protect the `terraform/<stage>` environments in GitLab to require approvals.
- **Per stage, per team with clusters there:** a GCP reader service account (prefix-scoped) and an
  AWS reader role that trusts only that team's cluster issuers. Per stage: the WIF pool/providers
  for EKS clusters, IAM OIDC providers for every cluster, and the DAAS writer role.
- **Authentication:** GitLab OIDC into GCP (workload identity federation) and each stage's AWS
  account (web identity). There are no stored keys. Create these once, outside this Terraform
  (bootstrap):
  - A GCP workload identity pool/provider for GitLab (`ci.gcpWorkloadIdentityProvider`).
  - `ci.plan` / `ci.apply` GCP service accounts. Plan gets viewer + state bucket read; apply gets
    editor on the secrets projects + state bucket write.
  - AWS roles with those names in every stage's account. Plan is read-only; apply needs IAM plus
    Secrets Manager admin. Both trust the GitLab OIDC provider.
  - Make the **apply** identities trust only the default branch (e.g. `ref_protected:true`), so MR
    pipelines can never obtain write access.
- **Locally:**
  ```bash
  cd terraform && python3 daas_tf.py config && cd live
  terraform init && terraform workspace select -or-create qa && terraform plan
  ```
  This uses your own GCP ADC and an AWS profile for that stage's account. `allowed_account_ids`
  stops you applying to the wrong account.

## Registry

Images come from a private registry (`registry` in `platform/service.yaml`). Every team namespace
gets the imagePullSecret `daas-registry`, synced by External Secrets from the team secret
`<team>_daas_REGISTRY_AUTH`. The value is a Docker config JSON, for example from a GitLab group
deploy token with `read_registry`:

```bash
jq -n --arg a "$(printf '%s:%s' "$USER" "$TOKEN" | base64)" \
  '{auths: {"registry.gitlab.example.com": {auth: $a}}}' |
bin/daas-secret set production payments daas REGISTRY_AUTH
```

Deploys to a stage are refused until it's set there. Remove the `registry` block if your registry
is public.

## Operations

- **Deployment records** live in SQLite (`DAAS_STATE_DB`, on a volume), so they survive restarts.
  A rollout interrupted by a restart is marked failed, and re-running the pipeline job converges.
  Run one replica.
- **Config changes without redeploying DAAS:** mount the platform repo with git-sync (or any
  synced checkout) at `DAAS_PLATFORM_DIR`. DAAS reloads every `DAAS_PLATFORM_RELOAD_SECONDS` when
  files change and re-renders platform objects. An invalid change is rejected, the last good
  config stays active, and `/healthz` shows the error. Changes to `conventions.yaml` or
  `gitopsRepo` are also rejected until a restart, because they rename resources.
- **GitOps repo:** with `DAAS_GITOPS_PUSH=true`, DAAS clones `gitopsRepo` (from `service.yaml`)
  into `DAAS_GITOPS_PATH`, authenticating with `DAAS_GITOPS_TOKEN` (a token with
  `write_repository`). The token is sent as a header and never written to disk.
- **Fast syncs:** set `DAAS_ARGOCD_WEBHOOK_URLS` to argocd-server's and the
  applicationset-controller's `/api/webhook`, plus `DAAS_ARGOCD_WEBHOOK_SECRET`. DAAS then pokes
  Argo CD after every commit instead of waiting for its ~3-minute poll. Adding the same webhook on
  the GitOps repo in GitLab also works.
- **Startup guards:** DAAS refuses to start with an unsafe combination:
  - `DAAS_AUTH_MODE=dev` (trusts headers) together with a real GitOps push or real secrets.
  - No `DAAS_STATE_DB` outside dev mode, since records would be lost on restart.
  - Without `DAAS_ARGOCD_URL`, since deploys would "succeed" without any health check, unless you
    set `DAAS_ALLOW_UNVERIFIED_HEALTH=true`.
- **Notifications:** DAAS posts `{"text": …}` (Slack, Teams and Mattermost compatible) when a
  deployment finishes. It goes to the webhooks in `DAAS_NOTIFY_WEBHOOKS` and to the team's own
  webhook, held in the DAAS env var that `access.yaml` names under `notify.webhookEnv`.
- **Alerts:** on clusters with the `prometheus-operator` feature, every service or worker gets a
  PrometheusRule (no available replicas for 5 minutes; crash-looping). Apps with `metrics` also
  get a ServiceMonitor or PodMonitor.
- **Secret rotation:** Deployments carry a stakater/Reloader annotation for their secrets, so
  pods restart when a rotated value syncs, provided Reloader is installed.

## Cluster prerequisites

Every cluster in `clusters.yaml` needs:

- **Argo CD access:** it's registered in the Argo CD hub under its `name`, and the hub can reach
  it (Workload Identity for GKE; an IAM role / access entry for EKS).
- **External Secrets Operator v0.16+:** needed for `external-secrets.io/v1` and GCP workload
  identity federation from EKS.
- **Workload identity:**
  - GKE: Workload Identity enabled, and the cluster's GCP name equals its `name`.
  - EKS: the IAM OIDC provider exists. Terraform creates it in each stage's account, or reuses it
    via `existingOidcProviders`. The EKS name must be ≤ 32 characters.
- **Gateway API:** a Gateway (`gateway.name` / `gateway.namespace`) on clusters with `ingress`
  and on preview clusters, with wildcard DNS for `domain` / `previewDomain` pointing at it.
- **Optional add-ons:** stakater/Reloader, and the Prometheus operator (then list
  `prometheus-operator` under `features`).
- **Namespace labels:** label monitoring and any other namespaces that must reach team pods with
  `daas/allow-ingress=true`.
- **When the gateway isn't a pod in the gateway namespace**, list its real sources under
  `ingressAllow`, or the default-deny NetworkPolicy blocks it:
  - GKE managed Gateway: `cidrs: [35.191.0.0/16, 130.211.0.0/22]`.
  - AWS load balancers in IP mode: the VPC CIDR.
  - Envoy Gateway: `namespaces: [envoy-gateway-system]`.
- **Prometheus selectors:** if your Prometheus only picks up ServiceMonitors and rules with
  certain labels (kube-prometheus-stack uses `release`), set `monitoringLabels`.

## Using GitLab's deployment features

| feature | used for |
|---|---|
| Environments + deployment tiers | every deploy is a GitLab deployment. Environments route to stages, and each stage requires its tier |
| Group-level protected environments (Premium) | protect the production tier once for all apps: approvals + allowed deployers |
| `resource_group` (+ `newest_first`) | one deploy per environment at a time; newest wins |
| Prevent outdated deployment jobs | an old pipeline can't overwrite a newer deploy |
| Environment rollback | GitLab re-runs an old deploy job, and DAAS redeploys that commit wave by wave |
| Deploy freezes (`$CI_DEPLOY_FREEZE`) | production deploys fail during freeze windows |
| Review apps (`on_stop`, `auto_stop_in`, dynamic URL) | previews per MR |
| OIDC `id_tokens` | the only auth between CI and DAAS |

The one-time GitLab settings are listed in `gitlab-component/README.md` under "GitLab setup".

## API

| method | path | |
|---|---|---|
| `POST` | `/v1/deployments` | `{spec, image, environment, dryRun}` → `{id, plan, url?, expiresAt?, skippedTargets?}` |
| `GET` | `/v1/deployments/{id}` | status per cluster (only for the project that created it) |
| `DELETE` | `/v1/environments/{environment}` | removes the caller's apps from that environment (`?app=` limits it to one) |
| `PUT` | `/v1/secrets/{stage}/{team}/{app}/{NAME}` | `{value, provider?}`. Entra ID; write-only |
| `GET` | `/v1/secrets/{stage}/{team}/{app}` | names, provider, updated. Never values |
| `DELETE` | `/v1/secrets/{stage}/{team}/{app}/{NAME}?provider=` | Entra ID |

Read API, for Backstage and other tools (Entra ID, any signed-in user; `X-DAAS-*` headers in dev mode):

| method | path | |
|---|---|---|
| `GET` | `/v1/schemas` | the JSON Schemas: `app` (`daas.yaml`), `teamAccess`, `teamClusters`, `teamSecrets` |
| `GET` | `/v1/platform` | stages, teams (access, clusters, secret writers), registry, conventions; `configError` if the last reload failed |
| `GET` | `/v1/apps?team=` | apps and where each environment runs, from the GitOps repo |
| `GET` | `/v1/deployments?team=&app=&environment=&limit=` | deployment records, newest first |
| `GET` | `/v1/apps/{team}/{app}/spec?environment=` | the `daas.yaml` of the latest deployment (pre-fills "update app") |
| `POST` | `/v1/preview` | `{spec, team, environment}` → `{valid, errors, warnings, skippedTargets, missingSecrets, plan, manifests}`. Never deploys |

## Backstage

`backstage/` holds three plugins for an existing Backstage app (new backend and new frontend system):

- **daas** (frontend): a DAAS page with a platform overview (stages as a promotion path, clusters,
  recent deployments), teams, apps with what runs where, deployments with per-wave rollout status,
  and write-only secrets per stage; plus a "Deployments" tab on catalog entities annotated
  `daas.io/app: <team>/<app>`.
- **daas-backend**: `/api/daas` (a permission-checked proxy to the read API; secret calls carry the
  user's own Entra token), a catalog provider that generates the *Deploy an app*, *Change an app*
  and *Onboard a team* templates from `/v1/schemas` + `/v1/platform`, and the scaffolder actions
  behind them. Every template ends in a merge request, validated by `/v1/preview` first.
- **daas-common**: shared types, permissions, and the schema → form mapping.

Because the templates are generated from the schemas, a new `daas.yaml` field, stage or team shows
up in the forms on the next refresh without editing a template. Setup: `backstage/README.md`.

## Run locally

```bash
cd api
pip install -r requirements-dev.txt
pytest -q

DAAS_AUTH_MODE=dev DAAS_SECRETS_BACKEND=memory DAAS_GITOPS_PATH=/tmp/daas-gitops \
  uvicorn daas_api.main:create_app --factory --port 8080

# dev auth trusts X-DAAS-* headers instead of GitLab / Entra tokens (tier defaults to the stage's)
H='-H content-type:application/json'
R='-H X-DAAS-Roles:payments.secrets'
for s in DB_URL STRIPE_KEY; do
  p=$([ $s = STRIPE_KEY ] && echo aws || echo gcp)
  curl -s -X PUT localhost:8080/v1/secrets/preview/payments/payments-api/$s $H $R \
    -d "{\"value\":\"dev\",\"provider\":\"$p\"}"
done
curl -s -X PUT localhost:8080/v1/secrets/preview/payments/daas/REGISTRY_AUTH $H $R \
  -d '{"value":"{\"auths\":{}}"}'                  # registry credentials (see Registry)

cd ../examples/payments-api
jq -n --rawfile spec daas.yaml --arg image reg/payments:1 --arg env review/mr-1 \
  '{spec:$spec, image:$image, environment:$env}' |
curl -s localhost:8080/v1/deployments $H --data @- \
  -H 'X-DAAS-Project: acme/payments/payments-api' -H 'X-DAAS-Environment: review/mr-1' | jq
```

## Configuration (env vars)

| var | default | |
|---|---|---|
| `DAAS_AUTH_MODE` | `gitlab` | `dev` trusts `X-DAAS-*` headers (project, environment, tier, user, roles). Local use only |
| `DAAS_GITLAB_URL` | `https://gitlab.com` | token issuer + JWKS |
| `DAAS_AUDIENCE` | `https://daas.example.com` | must equal the component's `api_url` |
| `DAAS_PLATFORM_DIR` | `../platform` | the platform folder (stages, conventions, service, teams) |
| `DAAS_GITOPS_PATH` | `/tmp/daas-gitops` | clone of the GitOps repo |
| `DAAS_GITOPS_PUSH` | `false` | `true` = clone `gitopsRepo`, pull --rebase / push on every commit |
| `DAAS_GITOPS_TOKEN` | empty | GitLab token with `write_repository` for the GitOps repo |
| `DAAS_STATE_DB` | empty (memory, dev only) | SQLite file for deployment records on a volume; required outside dev mode |
| `DAAS_PLATFORM_RELOAD_SECONDS` | `30` | how often to check the platform folder for changes; `0` = off |
| `DAAS_ALLOW_UNVERIFIED_HEALTH` | `false` | allow running without Argo CD health checks (not recommended) |
| `DAAS_ARGOCD_WEBHOOK_URLS`, `DAAS_ARGOCD_WEBHOOK_SECRET` | empty | poke Argo CD after each commit |
| `DAAS_NOTIFY_WEBHOOKS` | empty | chat webhooks for every deployment result (team webhooks: `notify.webhookEnv`) |
| `DAAS_SYNC_PLATFORM` | `true` | render platform objects (namespaces, secret access, AppProjects, ApplicationSets) on startup |
| `DAAS_ARGOCD_URL`, `DAAS_ARGOCD_TOKEN` | empty | empty = don't wait for health (status `committed`) |
| `DAAS_WAVE_TIMEOUT` | `600` | seconds per cluster to become healthy |
| `DAAS_SECRETS_BACKEND` | `cloud` | `memory` for local dev (values kept in process) |
| `DAAS_CHECK_SECRETS` | `true` | refuse deploys whose secrets aren't set for the stage |
| `DAAS_ENTRA_TENANT_ID`, `DAAS_ENTRA_AUDIENCE` | empty | Entra ID token validation for the secrets API |
| `DAAS_PREVIEW_TTL_HOURS` | `72` | preview expiry, refreshed on each deploy |
| `DAAS_REAPER_INTERVAL` | `900` | seconds between reaper runs; `0` = off |

## Known limits

- **One DAAS replica.** Rollouts run in-process and records are in SQLite.
- **No automatic rollback.** A failed wave stops the rollout; use GitLab's environment
  **Rollback** button, which re-runs the previous deploy job.
- **Cross-region traffic is DNS's job.** DAAS gives every region the same hostname. Weighted,
  latency or geo routing is set up in your DNS (for example external-dns with Route 53 or Cloud
  DNS).
- **Tag vs digest.** The component sends `$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA`. Resolving it to a
  digest (with `crane digest`) is a good next step.
- **Dependencies (databases, queues, buckets)** aren't provisioned by DAAS. Create them in the
  team's Terraform, or with Crossplane/Config Connector, put connection details in secrets, and
  grant access through `identity`.
- **Not yet run against real clouds:** the Terraform, and cross-cloud secret reads.
  - The Terraform is syntax-checked here. CI runs `terraform validate` on every MR, and the first
    real `plan` per stage is the real test.
  - The GCP and AWS secret backends and the GitLab/Entra token checks are covered by tests with
    fakes, moto and locally signed tokens. Do one real cross-cloud read per stage before relying
    on it.
