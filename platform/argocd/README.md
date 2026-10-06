# Argo CD bootstrap

Everything Argo CD needs is rendered from the `platform/` folder into the GitOps repo
(`platform/argocd/appprojects.yaml`, `platform/argocd/applicationsets.yaml`, `platform/<cluster>/…`).

Apply the single bootstrap Application to the hub once:

```bash
cd api && python -m daas_api.platform_render --bootstrap | kubectl apply -f -
```

It points Argo CD at `platform/argocd` in the GitOps repo, so the ApplicationSets and AppProjects,
and through them every cluster and app, are managed from there on.
