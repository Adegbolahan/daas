# daas-deploy GitLab CI/CD component

Publish this folder as its own GitLab project (e.g. `platform/daas-deploy`) and
mark it as a CI/CD Catalog project. Tag releases (`1.0.0`) so apps can pin a version.

```yaml
include:
  - component: $CI_SERVER_FQDN/platform/daas-deploy/deploy@1.0.0
    inputs:
      environment: production
      tier: production
      api_url: https://daas.example.com
```

| input | default | notes |
|---|---|---|
| environment | — | GitLab environment name; routed to a stage by the globs in `platform/stages.yaml` (`production-eu` → production, `qa-2` → qa) |
| tier | — | GitLab deployment tier; must equal the `gitlabTier` of the stage the environment routes to (`platform/stages.yaml`) |
| api_url | — | DAAS API base URL; also the OIDC `aud` |
| daas_file | `daas.yaml` | the app's deployment spec |
| image | `$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA` | used unless `daas.yaml` sets `image` |
| environment_url | `""` | link shown on the GitLab environment and MRs; defaults to the app's first public URL when it has `ingress` |
| stage | `deploy` | |
| dry_run | `false` | validate + print rendered manifests, deploy nothing |
| timeout_seconds | `1800` | how long to wait for rollout |
| job_suffix | `""` | lets you include the component twice for the same env |
| environment_action | `start` | `prepare` for dry runs (no GitLab deployment recorded) |
| respect_deploy_freeze | `true` | production-tier jobs fail while a deploy freeze is active |

What the job uses from GitLab:

- **`environment` + `deployment_tier`**: GitLab records every deployment. DAAS reads both from
  the job token, so a job can't claim a different environment or tier.
- **`resource_group: daas-<environment>`**: one deploy per environment at a time.
- **`id_tokens`**: OIDC auth. No secrets are stored in CI.
- **Dotenv `url`**: the environment link on the Environments page and in MRs.
- **`$CI_DEPLOY_FREEZE`**: blocks production deploys during freeze windows.

Auth uses GitLab's `id_tokens` (OIDC). No secrets are stored in CI.

## Preview per merge request (`review`)

```yaml
include:
  - component: $CI_SERVER_FQDN/platform/daas-deploy/review@1.0.0
    inputs:
      api_url: https://daas.example.com
```

This adds `daas-review`, which deploys to `review/mr-<iid>` and sets the MR's environment URL, and
`daas-review-stop`, which GitLab runs when the MR is merged or closed or after `auto_stop_in`.

| input | default |
|---|---|
| api_url | — |
| daas_file | `daas.yaml` |
| image | `$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA` |
| stage | `deploy` |
| auto_stop_in | `3 days` |
| timeout_seconds | `900` |

## GitLab setup (once, by the platform team)

These are settings rather than code, but DAAS depends on them.

1. **Protect the production tier at group level** (Premium). Go to Group > Settings > CI/CD >
   Protected environments and protect **production** by *deployment tier*. Set the allowed
   deployers and required approvals there. This covers every current and future app in the
   group, and DAAS rejects production-tier deploys whose token lacks `environment_protected: true`.
2. **Run the newest deploy first.** Resource groups default to `unordered`. Set each app's
   production resource group to `newest_first`, so an older queued pipeline can't deploy after a
   newer one:
   ```bash
   curl -X PUT -H "PRIVATE-TOKEN: $TOKEN" \
     "$GITLAB/api/v4/projects/$PROJECT_ID/resource_groups/daas-production?process_mode=newest_first"
   ```
3. **Turn on outdated-job protection and rollbacks.** Go to Project > Settings > CI/CD > General
   pipelines and enable **Prevent outdated deployment jobs** and **Allow job retries for rollback
   deployments**.
4. **Roll back from GitLab.** Go to Operate > Environments > production, pick an earlier
   deployment and choose **Rollback**. GitLab re-runs that old job, which resends that commit's
   `daas.yaml` and image, so DAAS rolls every region back the normal way, one wave at a time.
5. **Deploy freezes.** Configure them in Project > Settings > CI/CD > Deploy freezes. GitLab
   sets `$CI_DEPLOY_FREEZE` during the window, and the component refuses production-tier deploys.
