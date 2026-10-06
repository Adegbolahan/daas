import {
  appFormSteps,
  DAAS_FIELDS,
  formValuesToSpec,
  formValuesToTeamFiles,
  specToFormValues,
  teamFormSteps,
} from './schemaToForm';
import { platform, schemas } from './testing/fixtures';
import { toYaml } from './yaml';
import { parse } from 'yaml';

describe('appFormSteps', () => {
  const steps = appFormSteps(schemas.app, {
    platform,
    repository: { allowedHosts: ['gitlab.acme.io'], mode: 'create' },
    review: true,
  });
  const all = Object.assign({}, ...steps.map(s => s.properties));

  it('puts every schema property on some step', () => {
    const props = Object.keys(schemas.app.properties!).filter(k => k !== 'apiVersion');
    for (const p of props) expect(all).toHaveProperty(p);
  });

  it('starts with team & repository and ends with the review', () => {
    expect(steps[0].title).toBe('Team & repository');
    expect(steps[0].properties.team.enum).toEqual(['payments']);
    expect(steps[0].properties.team['ui:field']).toBe(DAAS_FIELDS.team);
    expect(steps[steps.length - 1].properties.previewSpec['ui:field']).toBe(DAAS_FIELDS.preview);
  });

  it('uses the DAAS widgets for targets, secrets and string maps', () => {
    expect(all.targets['ui:field']).toBe(DAAS_FIELDS.targets);
    expect(all.secrets['ui:field']).toBe(DAAS_FIELDS.secrets);
    expect(all.env['ui:field']).toBe(DAAS_FIELDS.keyValue);
  });

  it('offers overrides for exactly the platform stages', () => {
    expect(Object.keys(all.stages.properties)).toEqual(['review', 'dev', 'staging', 'production']);
  });

  it('shows fields the layout does not know under "Other settings"', () => {
    const extended = {
      ...schemas.app,
      properties: { ...schemas.app.properties, sidecars: { type: 'array', items: { type: 'string' } } },
    };
    const s = appFormSteps(extended, {});
    expect(s.find(x => x.title === 'Other settings')?.properties).toHaveProperty('sidecars');
  });
});

describe('formValuesToSpec', () => {
  it('drops form-only keys and empties, keeps schema order, and writes switched-on sections', () => {
    const spec = formValuesToSpec(
      {
        team: 'payments',
        repoUrl: 'x',
        previewSpec: '...',
        targets: [{ provider: 'gke', region: 'europe-west1' }],
        name: 'checkout',
        env: {},
        secrets: ['A', ''],
        ingress: { enabled: true },
        metrics: { enabled: false, path: '/metrics' },
        stages: {
          staging: { override: false, scaling: { min: 1 } },
          production: { override: true, scaling: { min: 6 }, env: {} },
          dev: { override: true, disablePublic: true },
        },
      },
      schemas.app,
    );
    expect(Object.keys(spec)[0]).toBe('apiVersion');
    expect(spec).not.toHaveProperty('team');
    expect(spec).not.toHaveProperty('env');
    expect(spec.secrets).toEqual(['A']);
    expect(spec.ingress).toEqual({});
    expect(spec).not.toHaveProperty('metrics');
    expect(spec.stages).toEqual({ production: { scaling: { min: 6 } }, dev: { ingress: null } });
    expect(Object.keys(spec).indexOf('name')).toBeLessThan(Object.keys(spec).indexOf('targets'));
  });

  it('round-trips through YAML and back into form values', () => {
    const values = {
      name: 'svc',
      port: 8080,
      ingress: { enabled: true, path: '/api' },
      targets: [{ provider: 'eks', region: 'us-east-1' }],
      stages: { production: { override: true, disablePublic: true } },
    };
    const yaml = toYaml(formValuesToSpec(values, schemas.app));
    expect(yaml).toContain('ingress: null');
    expect(specToFormValues(parse(yaml), schemas.app)).toEqual(values);
  });

  it('puts optional sections behind a switch, so defaults never switch them on', () => {
    const steps = appFormSteps(schemas.app, { platform });
    const all = Object.assign({}, ...steps.map(s => s.properties));
    expect(Object.keys(all.ingress.properties!)).toEqual(['enabled']);
    expect(all.ingress.properties!.enabled.default).toBe(false);
    const stage = all.stages.properties!.production;
    expect(Object.keys(stage.properties!)).toEqual(['override']);
    expect(JSON.stringify(stage)).not.toContain('"default":2');
  });
});

describe('team onboarding', () => {
  it('builds a form from the team schemas and the platform stages', () => {
    const steps = teamFormSteps(schemas, platform);
    const stages = steps.find(s => s.title === 'Stages & gates')!;
    expect(Object.keys(stages.properties.stages.properties!)).toEqual(['review', 'dev', 'staging', 'production']);
  });

  it('writes only enabled stages and the three team files', () => {
    const files = formValuesToTeamFiles({
      teamName: 'search',
      namespace: 'search',
      owners: ['linus@acme.io'],
      projects: ['acme/search/*'],
      stages: {
        dev: { enabled: true },
        production: { enabled: true, protectedRefOnly: true },
        staging: { enabled: false },
      },
      clusters: [{ name: 'search-prod-use1', stage: 'production', provider: 'eks', region: 'us-east-1' }],
      provider: 'aws',
    });
    expect(files.team).toBe('search');
    expect(files.access.stages).toEqual({ dev: {}, production: { protectedRefOnly: true } });
    expect(files.clusters).toHaveLength(1);
    expect(files.secrets).toEqual({ provider: 'aws' });
  });
});

describe('switched sections', () => {
  it('never carries additionalProperties: false next to the switch', () => {
    const steps = appFormSteps(schemas.app, { platform });
    const all = Object.assign({}, ...steps.map(s => s.properties));
    for (const key of ['ingress', 'metrics', 'scaling', 'resources']) {
      expect(all[key].additionalProperties).toBeUndefined();
    }
  });
});
