import type {
  AppView,
  DaasSchemas,
  DeploymentRecord,
  PlatformView,
  PreviewResult,
  SecretListItem,
} from '@internal/plugin-daas-common';
import { formValuesToSpec } from '@internal/plugin-daas-common';
import { parse } from 'yaml';
import type { DaasApi, UiConfig } from '../src/api';
// The real schemas, so the dev harness shows exactly what the templates will.
import appSchema from '../../../../spec/daas.schema.json';
import teamAccess from '../../../../spec/team-access.schema.json';
import teamClusters from '../../../../spec/team-clusters.schema.json';
import teamSecrets from '../../../../spec/team-secrets.schema.json';

export const schemas = { app: appSchema, teamAccess, teamClusters, teamSecrets } as unknown as DaasSchemas;

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

export const platform: PlatformView = {
  stages: [
    {
      name: 'review',
      gitlabTier: 'development',
      environments: ['review/*'],
      preview: true,
      partialTargets: true,
      allowStop: true,
      autoApply: true,
    },
    {
      name: 'dev',
      gitlabTier: 'development',
      environments: ['dev', 'qa-*'],
      preview: false,
      partialTargets: true,
      allowStop: true,
      autoApply: true,
    },
    {
      name: 'staging',
      gitlabTier: 'staging',
      environments: ['staging'],
      preview: false,
      partialTargets: false,
      allowStop: false,
      autoApply: true,
    },
    {
      name: 'production',
      gitlabTier: 'production',
      environments: ['production'],
      preview: false,
      partialTargets: false,
      allowStop: false,
      autoApply: false,
    },
  ],
  teams: [
    {
      name: 'payments',
      namespace: 'payments',
      group: 'acme/payments',
      owners: ['ada@acme.io', 'grace@acme.io'],
      projects: ['acme/payments/*'],
      stages: {
        review: {},
        dev: {},
        staging: { protectedRefOnly: true },
        production: { protectedRefOnly: true, requireProtectedEnvironment: true },
      },
      domains: ['pay.acme.io'],
      podSecurity: 'restricted',
      secretsProvider: 'gcp',
      secretWriters: { production: 'sg-payments-prod-secrets', staging: 'sg-payments-dev' },
      preview: { maxConcurrent: 5, quota: { cpu: '8', memory: '16Gi' } },
      clusters: [
        {
          name: 'payments-dev-euw1',
          stage: 'dev',
          provider: 'gke',
          region: 'europe-west1',
          domain: 'dev.pay.acme.io',
          previewDomain: null,
          hasGateway: true,
          features: [],
        },
        {
          name: 'payments-review-euw1',
          stage: 'review',
          provider: 'gke',
          region: 'europe-west1',
          domain: null,
          previewDomain: 'review.pay.acme.io',
          hasGateway: true,
          features: [],
        },
        {
          name: 'payments-stg-euw1',
          stage: 'staging',
          provider: 'gke',
          region: 'europe-west1',
          domain: 'stg.pay.acme.io',
          previewDomain: null,
          hasGateway: true,
          features: ['prometheus-operator'],
        },
        {
          name: 'payments-prod-euw1',
          stage: 'production',
          provider: 'gke',
          region: 'europe-west1',
          domain: 'pay.acme.io',
          previewDomain: null,
          hasGateway: true,
          features: ['prometheus-operator'],
        },
        {
          name: 'payments-prod-euw1-aws',
          stage: 'production',
          provider: 'eks',
          region: 'eu-west-1',
          domain: 'pay.acme.io',
          previewDomain: null,
          hasGateway: true,
          features: ['prometheus-operator'],
        },
        {
          name: 'payments-prod-use1',
          stage: 'production',
          provider: 'eks',
          region: 'us-east-1',
          domain: 'us.pay.acme.io',
          previewDomain: null,
          hasGateway: true,
          features: ['prometheus-operator'],
        },
      ],
    },
    {
      name: 'search',
      namespace: 'search',
      group: 'acme/search',
      owners: ['linus@acme.io'],
      projects: ['acme/search/*'],
      stages: { dev: {}, production: { protectedRefOnly: true } },
      domains: [],
      podSecurity: 'baseline',
      secretsProvider: 'aws',
      secretWriters: {},
      preview: {},
      clusters: [
        {
          name: 'search-dev-use1',
          stage: 'dev',
          provider: 'eks',
          region: 'us-east-1',
          domain: 'dev.search.acme.io',
          previewDomain: null,
          hasGateway: true,
          features: [],
        },
        {
          name: 'search-prod-use1',
          stage: 'production',
          provider: 'eks',
          region: 'us-east-1',
          domain: 'search.acme.io',
          previewDomain: null,
          hasGateway: true,
          features: [],
        },
        {
          name: 'search-prod-usw2',
          stage: 'production',
          provider: 'eks',
          region: 'us-west-2',
          domain: 'search.acme.io',
          previewDomain: null,
          hasGateway: true,
          features: [],
        },
      ],
    },
    {
      name: 'identity',
      namespace: 'identity',
      group: 'acme/identity',
      owners: ['margaret@acme.io'],
      projects: ['acme/identity/login'],
      stages: { review: {}, staging: {}, production: { requireProtectedEnvironment: true } },
      domains: [],
      podSecurity: 'restricted',
      secretsProvider: 'gcp',
      secretWriters: { production: 'sg-identity-prod' },
      preview: { maxConcurrent: 3 },
      clusters: [
        {
          name: 'identity-review-euw4',
          stage: 'review',
          provider: 'gke',
          region: 'europe-west4',
          domain: null,
          previewDomain: 'review.id.acme.io',
          hasGateway: true,
          features: [],
        },
        {
          name: 'identity-stg-euw4',
          stage: 'staging',
          provider: 'gke',
          region: 'europe-west4',
          domain: 'stg.id.acme.io',
          previewDomain: null,
          hasGateway: true,
          features: [],
        },
        {
          name: 'identity-prod-euw4',
          stage: 'production',
          provider: 'gke',
          region: 'europe-west4',
          domain: 'id.acme.io',
          previewDomain: null,
          hasGateway: true,
          features: [],
        },
      ],
    },
  ],
  registry: { server: 'europe-docker.pkg.dev/acme/apps' },
  conventions: { secretKeySeparator: '_', previewNamespaceSuffix: '-preview', platformSecretsApp: 'daas' },
  configError: null,
};

const img = (app: string, sha: string) =>
  `europe-docker.pkg.dev/acme/apps/${app}@sha256:${sha}0f3c9a1e77b2d4c8e5f60a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0`;

export const apps: AppView[] = [
  {
    team: 'payments',
    app: 'checkout-api',
    project: 'acme/payments/checkout-api',
    kind: 'service',
    environments: [
      {
        environment: 'production',
        stage: 'production',
        tier: 'production',
        name: 'checkout-api',
        namespace: 'payments',
        preview: false,
        image: img('checkout-api', '9b1d'),
        deploymentId: 'd-1',
        clusters: [
          { cluster: 'payments-prod-euw1', hosts: ['checkout.pay.acme.io'] },
          { cluster: 'payments-prod-euw1-aws', hosts: ['checkout.pay.acme.io'] },
          { cluster: 'payments-prod-use1', hosts: ['checkout.us.pay.acme.io'] },
        ],
      },
      {
        environment: 'staging',
        stage: 'staging',
        tier: 'staging',
        name: 'checkout-api',
        namespace: 'payments',
        preview: false,
        image: img('checkout-api', 'a7e2'),
        deploymentId: 'd-2',
        clusters: [{ cluster: 'payments-stg-euw1', hosts: ['checkout.stg.pay.acme.io'] }],
      },
      {
        environment: 'dev',
        stage: 'dev',
        tier: 'development',
        name: 'checkout-api',
        namespace: 'payments',
        preview: false,
        image: img('checkout-api', 'c3f4'),
        deploymentId: 'd-3',
        clusters: [{ cluster: 'payments-dev-euw1', hosts: ['checkout.dev.pay.acme.io'] }],
      },
      {
        environment: 'review/mr-42',
        stage: 'review',
        tier: 'development',
        name: 'checkout-api-mr-42',
        namespace: 'payments-preview',
        preview: true,
        expiresAt: new Date(now + 20 * 3600_000).toISOString(),
        image: img('checkout-api', 'e5a6'),
        deploymentId: 'd-4',
        clusters: [{ cluster: 'payments-review-euw1', hosts: ['checkout-api-mr-42.review.pay.acme.io'] }],
      },
    ],
  },
  {
    team: 'payments',
    app: 'ledger-worker',
    project: 'acme/payments/ledger',
    kind: 'worker',
    environments: [
      {
        environment: 'production',
        stage: 'production',
        tier: 'production',
        name: 'ledger-worker',
        namespace: 'payments',
        preview: false,
        image: img('ledger-worker', '11ab'),
        deploymentId: 'd-6',
        clusters: [{ cluster: 'payments-prod-euw1', hosts: [] }],
      },
      {
        environment: 'staging',
        stage: 'staging',
        tier: 'staging',
        name: 'ledger-worker',
        namespace: 'payments',
        preview: false,
        image: img('ledger-worker', '22cd'),
        deploymentId: 'd-7',
        clusters: [{ cluster: 'payments-stg-euw1', hosts: [] }],
      },
    ],
  },
  {
    team: 'search',
    app: 'indexer',
    project: 'acme/search/indexer',
    kind: 'cronjob',
    environments: [
      {
        environment: 'production',
        stage: 'production',
        tier: 'production',
        name: 'indexer',
        namespace: 'search',
        preview: false,
        image: img('indexer', '33ef'),
        deploymentId: 'd-8',
        clusters: [
          { cluster: 'search-prod-use1', hosts: [] },
          { cluster: 'search-prod-usw2', hosts: [] },
        ],
      },
    ],
  },
  {
    team: 'identity',
    app: 'login',
    project: 'acme/identity/login',
    kind: 'service',
    environments: [
      {
        environment: 'production',
        stage: 'production',
        tier: 'production',
        name: 'login',
        namespace: 'identity',
        preview: false,
        image: img('login', '44aa'),
        deploymentId: 'd-9',
        clusters: [{ cluster: 'identity-prod-euw4', hosts: ['login.id.acme.io'] }],
      },
    ],
  },
];

const by = (user: string, sha: string, ref = 'main', project = 'acme/payments/checkout-api') => ({
  project_path: project,
  ref,
  sha: `${sha}4f9e2b7c1d0a8e6f5c3b2a1d9e8f7c6b5a4d3e2f`,
  user_login: user,
  pipeline_id: String(880_000 + sha.charCodeAt(0) * 7),
});

export const deployments: DeploymentRecord[] = [
  {
    id: 'd-10',
    createdAt: ago(2),
    status: 'running',
    app: 'checkout-api',
    kind: 'service',
    name: 'checkout-api',
    namespace: 'payments',
    team: 'payments',
    environment: 'staging',
    stage: 'staging',
    tier: 'staging',
    image: img('checkout-api', 'b8c9'),
    requestedBy: by('ada', 'b8c9'),
    clusters: [{ cluster: 'payments-stg-euw1', wave: 1, status: 'syncing', revision: '5e1f00aa77' }],
  },
  {
    id: 'd-1',
    createdAt: ago(47),
    status: 'succeeded',
    app: 'checkout-api',
    kind: 'service',
    name: 'checkout-api',
    namespace: 'payments',
    team: 'payments',
    environment: 'production',
    stage: 'production',
    tier: 'production',
    image: img('checkout-api', '9b1d'),
    requestedBy: by('grace', '9b1d'),
    clusters: [
      { cluster: 'payments-prod-euw1', wave: 1, status: 'healthy', revision: 'aa01bc22dd' },
      { cluster: 'payments-prod-euw1-aws', wave: 2, status: 'healthy', revision: 'aa01bc22dd' },
      { cluster: 'payments-prod-use1', wave: 3, status: 'healthy', revision: 'aa01bc22dd' },
    ],
  },
  {
    id: 'd-4',
    createdAt: ago(95),
    status: 'succeeded',
    app: 'checkout-api',
    kind: 'service',
    name: 'checkout-api-mr-42',
    namespace: 'payments-preview',
    team: 'payments',
    environment: 'review/mr-42',
    stage: 'review',
    tier: 'development',
    image: img('checkout-api', 'e5a6'),
    requestedBy: by('ada', 'e5a6', 'feat/apple-pay'),
    clusters: [{ cluster: 'payments-review-euw1', wave: 1, status: 'healthy', revision: '09fe12ab34' }],
    expiresAt: new Date(now + 20 * 3600_000).toISOString(),
  },
  {
    id: 'd-11',
    createdAt: ago(130),
    status: 'failed',
    app: 'indexer',
    kind: 'cronjob',
    name: 'indexer',
    namespace: 'search',
    team: 'search',
    environment: 'production',
    stage: 'production',
    tier: 'production',
    image: img('indexer', '55bb'),
    requestedBy: by('linus', '55bb', 'main', 'acme/search/indexer'),
    message: 'wave 2: search-prod-usw2 unhealthy after 300s (Degraded: CronJob indexer: image pull back-off)',
    clusters: [
      { cluster: 'search-prod-use1', wave: 1, status: 'healthy', revision: '77aa88bb99' },
      {
        cluster: 'search-prod-usw2',
        wave: 2,
        status: 'unhealthy',
        revision: '77aa88bb99',
        detail: 'sync=Synced health=Degraded',
      },
    ],
  },
  {
    id: 'd-2',
    createdAt: ago(190),
    status: 'succeeded',
    app: 'checkout-api',
    kind: 'service',
    name: 'checkout-api',
    namespace: 'payments',
    team: 'payments',
    environment: 'staging',
    stage: 'staging',
    tier: 'staging',
    image: img('checkout-api', 'a7e2'),
    requestedBy: by('grace', 'a7e2'),
    clusters: [{ cluster: 'payments-stg-euw1', wave: 1, status: 'healthy', revision: '3c3c4d4d5e' }],
  },
  {
    id: 'd-9',
    createdAt: ago(300),
    status: 'succeeded',
    app: 'login',
    kind: 'service',
    name: 'login',
    namespace: 'identity',
    team: 'identity',
    environment: 'production',
    stage: 'production',
    tier: 'production',
    image: img('login', '44aa'),
    requestedBy: by('margaret', '44aa', 'main', 'acme/identity/login'),
    clusters: [{ cluster: 'identity-prod-euw4', wave: 1, status: 'healthy', revision: '1a2b3c4d5e' }],
  },
  {
    id: 'd-6',
    createdAt: ago(420),
    status: 'succeeded',
    app: 'ledger-worker',
    kind: 'worker',
    name: 'ledger-worker',
    namespace: 'payments',
    team: 'payments',
    environment: 'production',
    stage: 'production',
    tier: 'production',
    image: img('ledger-worker', '11ab'),
    requestedBy: by('ada', '11ab', 'main', 'acme/payments/ledger'),
    clusters: [{ cluster: 'payments-prod-euw1', wave: 1, status: 'healthy', revision: 'fe98dc76ba' }],
  },
  {
    id: 'd-3',
    createdAt: ago(600),
    status: 'succeeded',
    app: 'checkout-api',
    kind: 'service',
    name: 'checkout-api',
    namespace: 'payments',
    team: 'payments',
    environment: 'dev',
    stage: 'dev',
    tier: 'development',
    image: img('checkout-api', 'c3f4'),
    requestedBy: by('ada', 'c3f4', 'main'),
    clusters: [{ cluster: 'payments-dev-euw1', wave: 1, status: 'healthy', revision: 'c0ffee1234' }],
  },
  {
    id: 'd-8',
    createdAt: ago(1500),
    status: 'succeeded',
    app: 'indexer',
    kind: 'cronjob',
    name: 'indexer',
    namespace: 'search',
    team: 'search',
    environment: 'production',
    stage: 'production',
    tier: 'production',
    image: img('indexer', '33ef'),
    requestedBy: by('linus', '33ef', 'main', 'acme/search/indexer'),
    clusters: [
      { cluster: 'search-prod-use1', wave: 1, status: 'healthy', revision: '6655443322' },
      { cluster: 'search-prod-usw2', wave: 1, status: 'healthy', revision: '6655443322' },
    ],
  },
];

export const specs: Record<string, string> = {
  'payments/checkout-api': `# daas.yaml
apiVersion: daas/v1
name: checkout-api
port: 8080
env:
  LOG_LEVEL: info
  FEATURE_APPLE_PAY: "false"
resources:
  cpu: 500m
  memory: 512Mi
health:
  path: /healthz
scaling:
  min: 3
  max: 12
secrets:
  - DATABASE_URL
  - STRIPE_API_KEY
  - name: SIGNING_KEY
    from: aws
ingress:
  host: checkout
targets:
  - provider: gke
    region: europe-west1
  - provider: eks
    region: eu-west-1
  - provider: eks
    region: us-east-1
rollout:
  strategy: sequential
stages:
  production:
    scaling:
      min: 6
`,
};

const secretStore = new Map<string, SecretListItem[]>([
  [
    'production/payments/checkout-api',
    [
      { name: 'DATABASE_URL', provider: 'gcp', key: 'payments_checkout-api_DATABASE_URL', updated: ago(60 * 24 * 12) },
      { name: 'SIGNING_KEY', provider: 'aws', key: 'payments_checkout-api_SIGNING_KEY', updated: ago(60 * 24 * 40) },
      { name: 'LEGACY_TOKEN', provider: 'gcp', key: 'payments_checkout-api_LEGACY_TOKEN', updated: ago(60 * 24 * 200) },
    ],
  ],
]);

const delay = <T>(v: T, ms = 250) =>
  new Promise<T>(r => setTimeout(() => r(v === undefined ? v : JSON.parse(JSON.stringify(v))), ms));

/** In-memory DaasApi so the plugin can be developed and demoed without a DAAS API or backend. */
export class MockDaasApi implements DaasApi {
  uiConfig(): Promise<UiConfig> {
    return delay(
      {
        gitlabHost: 'gitlab.acme.io',
        scaffolderPath: '/create',
        templates: {
          create: 'template:default/daas-create-app',
          update: 'template:default/daas-update-app',
          onboard: 'template:default/daas-onboard-team',
        },
        secretsScope: '',
      },
      0,
    );
  }
  platform() {
    return delay(platform);
  }
  schemas(): Promise<DaasSchemas> {
    return delay(schemas);
  }
  apps(team?: string) {
    return delay(apps.filter(a => !team || a.team === team));
  }
  deployments(f: { team?: string; app?: string; environment?: string; limit?: number } = {}) {
    return delay(
      deployments
        .filter(
          d =>
            (!f.team || d.team === f.team) &&
            (!f.app || d.app === f.app) &&
            (!f.environment || d.environment === f.environment),
        )
        .slice(0, f.limit ?? 50),
    );
  }
  async appSpec(team: string, app: string, environment?: string) {
    const spec = specs[`${team}/${app}`];
    if (!spec) throw Object.assign(new Error(`no deployment of ${team}/${app} recorded yet`), { status: 404 });
    const view = apps.find(a => a.team === team && a.app === app);
    return delay({ spec, environment: environment ?? 'production', project: view?.project });
  }
  async preview(body: { spec: string; team: string; environment: string }): Promise<PreviewResult> {
    const doc = (parse(body.spec) ?? {}) as Record<string, any>;
    const team = platform.teams.find(t => t.name === body.team);
    const stage = platform.stages.find(s =>
      s.environments.some(p => new RegExp(`^${p.replace(/\*/g, '.*')}$`).test(body.environment)),
    );
    const errors: string[] = [];
    if (!doc.name) errors.push("'name' is required");
    if (!doc.targets?.length) errors.push("'targets' must have at least one entry");
    if (!team) errors.push(`unknown team '${body.team}'`);
    if (!stage) errors.push(`environment '${body.environment}' doesn't map to any stage`);
    else if (team && !team.stages[stage.name])
      errors.push(`team '${team.name}' may not deploy to stage '${stage.name}'`);
    const plan: PreviewResult['plan'] = [];
    const skipped: string[] = [];
    (doc.targets ?? []).forEach((t: { provider: 'gke' | 'eks'; region: string }, i: number) => {
      const cs =
        team?.clusters.filter(c => c.stage === stage?.name && c.provider === t.provider && c.region === t.region) ?? [];
      if (!cs.length) skipped.push(`${t.provider}/${t.region}`);
      for (const c of cs) {
        const host = doc.ingress && c.domain ? [`${doc.ingress.host ?? doc.name}.${c.domain}`] : [];
        plan.push({
          cluster: c.name,
          provider: c.provider,
          region: c.region,
          wave: doc.rollout?.strategy === 'parallel' ? 1 : i + 1,
          hosts: host,
        });
      }
    });
    const declared = (doc.secrets ?? []).map((s: any) => (typeof s === 'string' ? { name: s } : s));
    const have = new Set((secretStore.get(`${stage?.name}/${body.team}/${doc.name}`) ?? []).map(s => s.name));
    return delay(
      {
        valid: errors.length === 0,
        errors,
        warnings:
          doc.scaling?.min === 1 && stage?.name === 'production'
            ? ['scaling.min is 1 in production: no redundancy']
            : [],
        skippedTargets: stage?.partialTargets ? skipped : [],
        missingSecrets: declared
          .filter((s: any) => s.name && !have.has(s.name))
          .map((s: any) => ({ name: s.name, provider: s.from ?? team?.secretsProvider ?? 'gcp' })),
        plan,
        manifests: Object.fromEntries(
          plan.map(p => [
            p.cluster,
            `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${doc.name}\n  namespace: ${team?.namespace}\nspec:\n  replicas: ${doc.scaling?.min ?? 2}\n`,
          ]),
        ),
        kind: doc.schedule ? 'cronjob' : doc.port ? 'service' : 'worker',
        name: doc.name,
        namespace: team?.namespace,
        stage: stage?.name,
      },
      500,
    );
  }
  listSecrets(stage: string, team: string, app: string) {
    return delay(secretStore.get(`${stage}/${team}/${app}`) ?? []);
  }
  async putSecret(stage: string, team: string, app: string, name: string, _value: string, provider?: 'gcp' | 'aws') {
    const key = `${stage}/${team}/${app}`;
    const t = platform.teams.find(x => x.name === team);
    const p = provider ?? t?.secretsProvider ?? 'gcp';
    const list = (secretStore.get(key) ?? []).filter(s => s.name !== name);
    list.push({ name, provider: p, key: `${team}_${app}_${name}`, updated: new Date().toISOString() });
    secretStore.set(key, list);
    return delay({ key: `${team}_${app}_${name}`, provider: p });
  }
  async deleteSecret(stage: string, team: string, app: string, name: string) {
    const key = `${stage}/${team}/${app}`;
    secretStore.set(
      key,
      (secretStore.get(key) ?? []).filter(s => s.name !== name),
    );
    await delay(undefined);
  }
}

/** Handy for the fields playground: the form values an update of checkout-api starts from. */
export function checkoutFormValues(): Record<string, unknown> {
  const doc = parse(specs['payments/checkout-api']) as Record<string, unknown>;
  const { apiVersion: _v, ...rest } = doc;
  return { team: 'payments', environment: 'production', ...rest };
}

export { formValuesToSpec };
