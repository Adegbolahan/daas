/**
 * Turn the DAAS JSON Schemas into Scaffolder form steps, and form values back into files.
 *
 * Everything here is driven by the schemas the DAAS API serves (GET /v1/schemas) and the platform
 * view (GET /v1/platform). A field added to the schema shows up in the templates automatically:
 * known fields get a friendlier widget, anything else lands in an "Other settings" step.
 */
import { JsonSchema, PlatformView } from './types';

/** Custom Scaffolder field extensions provided by the DAAS frontend plugin. */
export const DAAS_FIELDS = {
  team: 'DaasTeamPicker',
  targets: 'DaasTargetsPicker',
  keyValue: 'DaasKeyValue',
  secrets: 'DaasSecretsEditor',
  preview: 'DaasSpecPreview',
} as const;

/** Keys in form values that aren't part of the spec itself. */
export const FORM_META_KEYS = ['team', 'repoUrl', 'branch', 'environment', 'addCiInclude', 'previewSpec'] as const;

export interface FormStep {
  title: string;
  description?: string;
  required?: string[];
  properties: Record<string, JsonSchema>;
  [key: string]: unknown;
}

interface StepLayout {
  title: string;
  description: string;
  properties: string[];
}

export const APP_STEP_LAYOUT: StepLayout[] = [
  {
    title: 'Basics',
    description: 'What the app is. A port makes it a service, no port a worker, a schedule a cron job.',
    properties: ['name', 'port', 'schedule', 'image', 'command', 'args'],
  },
  {
    title: 'Runtime',
    description: 'Configuration, size and scaling. Stages can override these later.',
    properties: ['env', 'resources', 'health', 'scaling'],
  },
  {
    title: 'Secrets & identity',
    description: 'Secret names only: values are set per stage in the DAAS secrets page, never here.',
    properties: ['secrets', 'identity'],
  },
  {
    title: 'Traffic & telemetry',
    description: 'Public exposure through the cluster Gateway, and Prometheus metrics.',
    properties: ['ingress', 'metrics'],
  },
  {
    title: 'Placement',
    description: 'Production regions, in rollout order. The first one is the canary.',
    properties: ['targets', 'rollout'],
  },
  {
    title: 'Per-stage overrides',
    description: 'Only what differs per stage: env/scaling/resources merge, identity/ingress/targets replace.',
    properties: ['stages'],
  },
];

const HIDDEN = new Set(['apiVersion']);

/** Resolve local `#/$defs/...` references (the DAAS schemas have no cycles). */
export function deref(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/\$defs\//, '');
    const target = root.$defs?.[name];
    if (!target) throw new Error(`Unresolvable $ref ${schema.$ref}`);
    const { $ref: _ignored, ...rest } = schema;
    return deref({ ...target, ...rest }, root);
  }
  const out: JsonSchema = { ...schema };
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, deref(v, root)]));
  }
  if (schema.items) out.items = deref(schema.items, root);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    out.additionalProperties = deref(schema.additionalProperties, root);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const list = schema[key] as JsonSchema[] | undefined;
    if (list) out[key] = list.map(s => deref(s, root));
  }
  delete out.$defs;
  delete out.$schema;
  delete out.$id;
  return out;
}

function humanize(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Decorate one property with a title, help text and, for known fields, a DAAS widget. */
export function decorate(key: string, schema: JsonSchema, path: string[] = []): JsonSchema {
  const s: JsonSchema = { ...schema, title: schema.title ?? humanize(key) };
  if (schema.description) {
    s['ui:help'] = schema.description;
    delete s.description;
  }
  const where = [...path, key].join('.');
  const isStringMap = s.type === 'object' && !s.properties && typeof s.additionalProperties === 'object';
  if (key === 'targets') s['ui:field'] = DAAS_FIELDS.targets;
  else if (key === 'secrets' && s.type === 'array') s['ui:field'] = DAAS_FIELDS.secrets;
  else if (isStringMap) s['ui:field'] = DAAS_FIELDS.keyValue;
  else if (s.type === 'object' && s.properties) {
    s.properties = Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, decorate(k, v, [...path, key])]),
    );
    s['ui:options'] = { ...(s['ui:options'] as object), collapsed: path.length > 0 };
  } else if (s.type === 'array' && s.items) {
    s.items = decorate(`${key} item`, s.items, [...path, key]);
    // "Projects item" reads badly; the array's own title already says what the rows are.
    if (s.items.type === 'string' || s.items.type === 'number') s.items = { ...s.items, title: '' };
    if (s.items.type === 'string') s['ui:options'] = { orderable: true };
  }
  if (where === 'command' || where === 'args') s['ui:placeholder'] = key === 'command' ? 'python' : 'app.py';
  if (key === 'name' && path.length === 0) s['ui:autofocus'] = true;
  return s;
}

/** Copy of a schema without `default`/`minItems`, so an untouched override stays empty. */
function withoutDefaults(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema)) return schema.map(withoutDefaults) as unknown as JsonSchema;
  if (!schema || typeof schema !== 'object') return schema;
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'default' || k === 'minItems') continue;
    out[k] = v && typeof v === 'object' ? withoutDefaults(v as JsonSchema) : v;
  }
  return out;
}

/** Form-only keys inside a stage override. */
export const OVERRIDE_KEYS = { enabled: 'override', publicOff: 'disablePublic' } as const;

/**
 * Stage overrides: the schema allows any stage name; the form offers exactly the stages the
 * platform has. Each starts as one switch ("Override settings for staging"); turning it on reveals
 * that stage's fields, with no defaults filled in, so only what you change ends up in daas.yaml.
 */
function stageOverrides(schema: JsonSchema, platform?: PlatformView): JsonSchema {
  const item = typeof schema.additionalProperties === 'object' ? schema.additionalProperties : {};
  const stages = platform?.stages.map(s => s.name) ?? [];
  if (!stages.length) return decorate('stages', schema);
  return {
    type: 'object',
    title: 'Per-stage overrides',
    'ui:help': schema.description,
    properties: Object.fromEntries(
      stages.map(stage => {
        const fields = { ...(decorate(stage, withoutDefaults(item), ['stages']).properties ?? {}) };
        // `ingress: null` turns exposure off; a oneOf with null renders as "option 1/2", so offer
        // a plain switch for "off" and the ingress object for a custom one.
        const ingress = fields.ingress;
        const custom = (ingress?.oneOf as JsonSchema[] | undefined)?.find(o => o.type !== 'null');
        if (ingress && custom) {
          fields.ingress = decorate('ingress', { ...custom, title: 'Custom public exposure' }, ['stages', stage]);
          fields[OVERRIDE_KEYS.publicOff] = {
            type: 'boolean',
            title: `No public exposure in ${stage}`,
            'ui:help': 'Removes the HTTPRoute in this stage (ingress: null).',
          };
        }
        if (fields.targets) fields.targets = { ...fields.targets, 'ui:options': { stage } };
        return [
          stage,
          {
            type: 'object',
            title: stage,
            properties: {
              [OVERRIDE_KEYS.enabled]: { type: 'boolean', title: `Override settings for ${stage}`, default: false },
            },
            dependencies: {
              [OVERRIDE_KEYS.enabled]: {
                oneOf: [
                  { properties: { [OVERRIDE_KEYS.enabled]: { enum: [false] } } },
                  { properties: { [OVERRIDE_KEYS.enabled]: { enum: [true] }, ...fields } },
                ],
              },
            },
          },
        ];
      }),
    ),
  };
}

/** Form values of `stages` → the daas.yaml `stages:` map (only switched-on stages, only set fields). */
function overridesToSpec(values: unknown): Record<string, unknown> | undefined {
  if (!values || typeof values !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [stage, raw] of Object.entries(values as Record<string, Record<string, unknown>>)) {
    if (!raw || typeof raw !== 'object') continue;
    const hasToggle = OVERRIDE_KEYS.enabled in raw;
    if (hasToggle && !raw[OVERRIDE_KEYS.enabled]) continue;
    const { [OVERRIDE_KEYS.enabled]: _on, [OVERRIDE_KEYS.publicOff]: off, ...rest } = raw;
    const ov = (prune(rest) as Record<string, unknown>) ?? {};
    if (off) ov.ingress = null;
    if (Object.keys(ov).length) out[stage] = ov;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The daas.yaml `stages:` map → form values (the reverse of overridesToSpec). */
function overridesToForm(stages: unknown): Record<string, unknown> | undefined {
  if (!stages || typeof stages !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(stages as Record<string, Record<string, unknown>>).map(([stage, ov]) => {
      const { ingress, ...rest } = ov ?? {};
      return [
        stage,
        {
          [OVERRIDE_KEYS.enabled]: true,
          ...rest,
          ...(ingress === null ? { [OVERRIDE_KEYS.publicOff]: true } : ingress ? { ingress } : {}),
        },
      ];
    }),
  );
}

/** Form-only switch on optional sections whose mere presence changes behavior. */
export const SECTION_SWITCH = 'enabled';

const SWITCH_TITLES: Record<string, string> = {
  ingress: 'Expose the app publicly',
  metrics: 'Scrape Prometheus metrics',
  health: 'Set health check paths',
  scaling: 'Customize scaling',
  resources: 'Customize CPU and memory',
  identity: 'Give the app a cloud identity',
  rollout: 'Customize the rollout',
};

/**
 * Top-level optional objects (ingress, metrics, scaling, ...). Their presence in daas.yaml means
 * something (`ingress: {}` exposes the app), so the form must not add them just because the schema
 * has defaults: each gets a switch, and its fields (with their defaults) appear once it's on.
 */
export function switchedSections(appSchema: JsonSchema): Set<string> {
  const required = new Set(appSchema.required ?? []);
  const out = new Set<string>();
  for (const [key, raw] of Object.entries(appSchema.properties ?? {})) {
    if (required.has(key) || key === 'stages') continue;
    const s = deref(raw, appSchema);
    if (s.type === 'object' && s.properties && !(SECTION_SWITCH in s.properties)) out.add(key);
  }
  return out;
}

function switchable(key: string, s: JsonSchema): JsonSchema {
  // additionalProperties: false would reject the switch itself; daas.yaml is validated by DAAS anyway.
  const { properties, required, additionalProperties: _a, 'ui:options': _o, ...rest } = s;
  return {
    ...rest,
    type: 'object',
    properties: {
      [SECTION_SWITCH]: {
        type: 'boolean',
        title: SWITCH_TITLES[key] ?? `Set ${String(s.title ?? key).toLowerCase()}`,
        default: false,
      },
    },
    dependencies: {
      [SECTION_SWITCH]: {
        oneOf: [
          { properties: { [SECTION_SWITCH]: { enum: [false] } } },
          { properties: { [SECTION_SWITCH]: { enum: [true] }, ...properties }, ...(required ? { required } : {}) },
        ],
      },
    },
  };
}

export interface AppFormOptions {
  platform?: PlatformView;
  /** Include the repository step (create/update via merge request). */
  repository?: { allowedHosts: string[]; mode: 'create' | 'update' };
  /** Include a final review step with a live preview of the plan per stage. */
  review?: boolean;
}

/** Scaffolder parameter steps for an app's daas.yaml. */
export function appFormSteps(appSchema: JsonSchema, opts: AppFormOptions = {}): FormStep[] {
  const root = appSchema;
  const props = root.properties ?? {};
  const required = new Set(root.required ?? []);
  const switched = switchedSections(root);
  const used = new Set<string>();
  const steps: FormStep[] = [];

  if (opts.repository) {
    steps.push({
      title: 'Team & repository',
      description:
        opts.repository.mode === 'create'
          ? 'DAAS opens a merge request that adds daas.yaml (and the CI include) to this repository.'
          : 'DAAS opens a merge request that updates daas.yaml in this repository.',
      required: ['team', 'repoUrl'],
      properties: {
        team: {
          type: 'string',
          title: 'Team',
          enum: opts.platform?.teams.map(t => t.name),
          'ui:field': DAAS_FIELDS.team,
          'ui:help': 'The team that owns the app. Its access.yaml decides where it can deploy.',
        },
        repoUrl: {
          type: 'string',
          title: 'Repository',
          'ui:field': 'RepoUrlPicker',
          'ui:options': { allowedHosts: opts.repository.allowedHosts },
        },
        branch: { type: 'string', title: 'Target branch', default: 'main' },
        ...(opts.repository.mode === 'create'
          ? {
              addCiInclude: {
                type: 'boolean',
                title: 'Add the DAAS CI components to .gitlab-ci.yml',
                default: true,
              },
            }
          : {}),
      },
    });
  }

  for (const layout of APP_STEP_LAYOUT) {
    const properties: Record<string, JsonSchema> = {};
    for (const key of layout.properties) {
      const p = props[key];
      if (!p) continue;
      used.add(key);
      const resolved = deref(p, root);
      properties[key] =
        key === 'stages'
          ? stageOverrides(resolved, opts.platform)
          : switched.has(key)
            ? switchable(key, decorate(key, resolved))
            : decorate(key, resolved);
    }
    if (Object.keys(properties).length) {
      steps.push({
        title: layout.title,
        description: layout.description,
        required: Object.keys(properties).filter(k => required.has(k)),
        properties,
      });
    }
  }

  // Anything the schema gained that the layout doesn't know yet still gets a form.
  const rest = Object.keys(props).filter(k => !used.has(k) && !HIDDEN.has(k));
  if (rest.length) {
    steps.push({
      title: 'Other settings',
      required: rest.filter(k => required.has(k)),
      properties: Object.fromEntries(rest.map(k => [k, decorate(k, deref(props[k], root))])),
    });
  }

  if (opts.review) {
    steps.push({
      title: 'Plan',
      description: 'Validated by DAAS against your team and a stage, before anything is committed.',
      properties: {
        environment: {
          type: 'string',
          title: 'Preview against environment',
          default: 'production',
          'ui:help': 'Any GitLab environment name; it routes to a stage (e.g. qa-1, staging, production).',
        },
        previewSpec: {
          type: 'string',
          title: 'Plan',
          'ui:field': DAAS_FIELDS.preview,
          'ui:backstage': { review: { show: false } },
        },
      },
    });
  }
  return steps;
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

/** Remove empty values recursively (forms leave lots of `{}` and `[]` behind). */
export function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(prune).filter(v => !isEmpty(v));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const p = prune(v);
      if (!isEmpty(p)) out[k] = p;
    }
    return out;
  }
  return value;
}

/**
 * Form values → a daas.yaml object, keys in schema order. Switched sections are written only when
 * switched on, and then even when empty (`ingress: {}` exposes the app with defaults).
 */
export function formValuesToSpec(values: Record<string, unknown>, appSchema: JsonSchema): Record<string, unknown> {
  const order = Object.keys(appSchema.properties ?? {});
  const switched = switchedSections(appSchema);
  const spec: Record<string, unknown> = { apiVersion: 'daas/v1' };
  for (const key of order) {
    if (key === 'apiVersion' || !(key in values)) continue;
    const raw = values[key];
    if (key === 'stages') {
      const ov = overridesToSpec(raw);
      if (ov) spec.stages = ov;
      continue;
    }
    if (switched.has(key)) {
      if (raw && typeof raw === 'object' && (raw as Record<string, unknown>)[SECTION_SWITCH]) {
        const { [SECTION_SWITCH]: _on, ...fields } = raw as Record<string, unknown>;
        spec[key] = prune(fields) ?? {};
      }
      continue;
    }
    const v = prune(raw);
    if (!isEmpty(v)) spec[key] = v;
  }
  return spec;
}

/** A daas.yaml object → form values (used to pre-fill the update template). */
export function specToFormValues(spec: Record<string, unknown>, appSchema: JsonSchema): Record<string, unknown> {
  const { apiVersion: _v, stages, ...rest } = spec;
  const switched = switchedSections(appSchema);
  for (const key of switched) {
    const v = rest[key];
    if (v && typeof v === 'object') rest[key] = { [SECTION_SWITCH]: true, ...(v as object) };
  }
  const ov = overridesToForm(stages);
  return ov ? { ...rest, stages: ov } : rest;
}

// ---------------------------------------------------------------- team onboarding

export const TEAM_STEP_LAYOUT: StepLayout[] = [
  {
    title: 'Team',
    description: 'Who the team is and which GitLab projects may deploy as it.',
    properties: ['namespace', 'group', 'owners', 'projects'],
  },
  {
    title: 'Stages & gates',
    description: 'Where the team may deploy, and the extra gates per stage.',
    properties: ['stages', 'podSecurity', 'domains', 'preview', 'notify'],
  },
];

/** Scaffolder steps for onboarding a team (platform/teams/<team>/*.yaml). */
export function teamFormSteps(
  schemas: { teamAccess: JsonSchema; teamClusters: JsonSchema; teamSecrets: JsonSchema },
  platform?: PlatformView,
): FormStep[] {
  const access = schemas.teamAccess;
  const props = access.properties ?? {};
  const stageNames = platform?.stages.map(s => s.name) ?? [];
  const gateSchema = typeof props.stages?.additionalProperties === 'object' ? props.stages.additionalProperties : {};

  const steps: FormStep[] = [];
  steps.push({
    title: 'Team',
    description: TEAM_STEP_LAYOUT[0].description,
    required: ['teamName', 'projects'],
    properties: {
      teamName: {
        type: 'string',
        title: 'Team name',
        pattern: '^[a-z]([-a-z0-9]{0,19}[a-z0-9])?$',
        'ui:help': 'Folder name under platform/teams/. Cluster names must start with it.',
        'ui:autofocus': true,
      },
      ...Object.fromEntries(
        TEAM_STEP_LAYOUT[0].properties.filter(k => props[k]).map(k => [k, decorate(k, deref(props[k], access))]),
      ),
    },
  });

  const stageProps: Record<string, JsonSchema> = Object.fromEntries(
    stageNames.map(name => [
      name,
      {
        type: 'object',
        title: name,
        properties: {
          enabled: { type: 'boolean', title: `Deploy to ${name}`, default: false },
        },
        // The gates only mean something for a stage the team deploys to.
        dependencies: {
          enabled: {
            oneOf: [
              { properties: { enabled: { enum: [false] } } },
              {
                properties: {
                  enabled: { enum: [true] },
                  ...Object.fromEntries(
                    Object.entries(gateSchema.properties ?? {}).map(([k, v]) => [k, decorate(k, v)]),
                  ),
                },
              },
            ],
          },
        },
      },
    ]),
  );
  steps.push({
    title: 'Stages & gates',
    description: TEAM_STEP_LAYOUT[1].description,
    properties: {
      stages: { type: 'object', title: 'Stages', properties: stageProps },
      ...Object.fromEntries(
        TEAM_STEP_LAYOUT[1].properties
          .filter(k => k !== 'stages' && props[k])
          .map(k => [k, decorate(k, deref(props[k], access))]),
      ),
    },
  });

  const clusterItem = deref(schemas.teamClusters.items ?? {}, schemas.teamClusters);
  const { allOf: _allOf, ...clusterItemPlain } = clusterItem;
  if (stageNames.length && clusterItemPlain.properties?.stage) {
    clusterItemPlain.properties.stage = { ...clusterItemPlain.properties.stage, enum: stageNames };
  }
  steps.push({
    title: 'Clusters',
    description: 'The team’s dedicated clusters. GKE needs gcpProject, EKS needs oidcIssuer. Names start with <team>-.',
    properties: {
      clusters: {
        type: 'array',
        title: 'Clusters',
        items: decorate('cluster', clusterItemPlain),
        'ui:options': { orderable: false },
      },
    },
  });

  const sec = deref(schemas.teamSecrets, schemas.teamSecrets);
  steps.push({
    title: 'Secrets',
    description: 'Where the team’s secrets live by default, and which Entra roles may write them.',
    properties: Object.fromEntries(Object.entries(sec.properties ?? {}).map(([k, v]) => [k, decorate(k, v)])),
  });

  steps.push({
    title: 'Platform repository',
    required: ['repoUrl'],
    properties: {
      repoUrl: { type: 'string', title: 'Platform repository', 'ui:field': 'RepoUrlPicker' },
      branch: { type: 'string', title: 'Target branch', default: 'main' },
    },
  });
  return steps;
}

export interface TeamFiles {
  team: string;
  access: Record<string, unknown>;
  clusters: Record<string, unknown>[];
  secrets: Record<string, unknown>;
}

/** Onboarding form values → the three files of platform/teams/<team>/. */
export function formValuesToTeamFiles(values: Record<string, unknown>): TeamFiles {
  const team = String(values.teamName ?? '');
  const stagesIn = (values.stages ?? {}) as Record<string, Record<string, unknown>>;
  const stages: Record<string, Record<string, unknown>> = {};
  for (const [name, v] of Object.entries(stagesIn)) {
    if (!v?.enabled) continue;
    const { enabled: _e, ...gates } = v;
    stages[name] = (prune(gates) as Record<string, unknown>) ?? {};
  }
  const accessKeys = ['namespace', 'group', 'owners', 'projects', 'podSecurity', 'domains', 'preview', 'notify'];
  const access: Record<string, unknown> = {};
  for (const k of accessKeys) {
    const v = prune(values[k]);
    if (!isEmpty(v)) access[k] = v;
  }
  access.stages = stages;
  const clusters = ((prune(values.clusters) as Record<string, unknown>[]) ?? []).filter(Boolean);
  const secrets: Record<string, unknown> = {};
  for (const k of ['provider', 'writers']) {
    const v = prune(values[k]);
    if (!isEmpty(v)) secrets[k] = v;
  }
  return { team, access, clusters, secrets };
}
