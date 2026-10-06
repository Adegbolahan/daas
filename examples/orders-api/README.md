# orders-api: a starter app on DAAS

The smallest app that follows the DAAS contract. Copy this folder into a new GitLab project under
`acme/orders/` to get previews, qa, staging and multi-region production with no Kubernetes YAML.

| file | what it's for |
|---|---|
| `daas.yaml` | everything DAAS needs: port, health checks, resources, scaling, secrets, regions |
| `.gitlab-ci.yml` | build, then the DAAS components: preview per MR, staging, production |
| `Dockerfile`, `main.py` | the app: `/healthz`, `/ready` (503 until its secrets are present), `/` |

## First deploy

1. **Is the team onboarded?** `orders` needs a folder in the platform repo: `platform/teams/orders/`
   (`access.yaml`, `clusters.yaml`, `secrets.yaml`). Its generated `README.md` lists the stages,
   clusters, identities and gates you have.
2. **Set secrets for each stage you'll use.** You need the Entra role `orders.secrets`, or
   `orders.secrets.prod` for production:
   ```bash
   echo -n 'postgres://…' | daas-secret set preview orders orders-api DATABASE_URL
   echo -n 'pk_test_…'    | daas-secret set preview orders orders-api PAYMENTS_API_KEY gcp
   # repeat for qa, staging and production
   ```
   The team also needs its registry pull credentials once per stage
   (`daas-secret set <stage> orders daas REGISTRY_AUTH < dockerconfig.json`; see the DAAS README,
   "Registry").
   A deploy to a stage where a secret is missing fails right away and tells you which one.
3. **Open an MR.** The pipeline builds the image and posts the preview URL on the MR.
4. **Merge.** It deploys to qa, staging, then production (after approval) region by region, with
   the first target as the canary.

## Notes

- **Regions per stage:** `targets` lists production regions. Stages marked `partialTargets` in
  `platform/stages.yaml` (qa, staging, …) deploy to whichever of those regions the team has a
  cluster for there and report the rest as `skippedTargets`. Production requires every target.
- **Readiness:** `/ready` returns 503 until `DATABASE_URL` and `PAYMENTS_API_KEY` are set. A
  missing secret shows up as a rollout that never becomes healthy, never as a crash loop.

Run locally: `PORT=8080 DATABASE_URL=x PAYMENTS_API_KEY=y python main.py`
