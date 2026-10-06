import { platform, schemas } from './testing/fixtures';
import { buildTemplates } from './templates';

const settings = {
  daasBaseUrl: 'https://daas.acme.io',
  owner: 'group:default/platform',
  gitlabHost: 'gitlab.acme.io',
  platformRepoUrl: 'gitlab.acme.io?owner=platform&repo=daas-platform',
};

describe('buildTemplates', () => {
  const entities = buildTemplates(schemas, platform, settings);
  const byName = Object.fromEntries(entities.map(e => [e.metadata.name, e]));

  it('generates create, update and onboarding templates', () => {
    expect(Object.keys(byName).sort()).toEqual(['daas-create-app', 'daas-onboard-team', 'daas-update-app']);
    for (const e of entities) {
      expect(e.kind).toBe('Template');
      expect(e.metadata.annotations?.['backstage.io/managed-by-location']).toBe('url:https://daas.acme.io/v1/schemas');
      expect(e.spec?.owner).toBe(settings.owner);
    }
  });

  it('writes daas.yaml and opens a merge request', () => {
    const steps = (byName['daas-create-app'].spec as any).steps;
    expect(steps.map((s: any) => s.action)).toEqual(['daas:spec:write', 'publish:gitlab:merge-request']);
    expect(steps[1].input.branchName).toBe('${{ steps.spec.output.branch }}');
    expect(steps[0].input.mode).toBe('create');
    expect((byName['daas-update-app'].spec as any).steps[0].input).not.toHaveProperty('addCiInclude');
  });

  it('points onboarding at the platform repository', () => {
    const params = (byName['daas-onboard-team'].spec as any).parameters as any[];
    const repo = params.find(p => p.properties.repoUrl).properties.repoUrl;
    expect(repo.default).toBe(settings.platformRepoUrl);
  });
});
