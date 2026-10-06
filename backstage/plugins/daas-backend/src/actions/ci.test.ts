import { platform } from '@internal/plugin-daas-common/testing';
import { parse } from 'yaml';
import { daasIncludes, environmentFor, mergeGitlabCi } from './ci';

const ci = { componentProject: 'platform/daas-components', componentVersion: '1.4.0', apiUrl: 'https://daas.acme.io' };
const team = platform.teams[0];

describe('daasIncludes', () => {
  it('adds a review include and one deploy per enabled stage, in platform order', () => {
    const plan = daasIncludes(platform, team, ci);
    expect(plan.ciStages).toEqual(['daas-staging', 'daas-production']);
    expect(plan.includes.map(i => i.component)).toEqual([
      '$CI_SERVER_FQDN/platform/daas-components/review@1.4.0',
      '$CI_SERVER_FQDN/platform/daas-components/deploy@1.4.0',
      '$CI_SERVER_FQDN/platform/daas-components/deploy@1.4.0',
    ]);
    expect((plan.includes[2].inputs as any).tier).toBe('production');
  });

  it('uses the first plain environment name of a stage', () => {
    expect(environmentFor(platform.stages[1])).toBe('dev');
    expect(environmentFor(platform.stages[0])).toBe('review');
  });
});

describe('mergeGitlabCi', () => {
  const plan = daasIncludes(platform, team, ci);

  it('creates a pipeline with a build job when there is none', () => {
    const out = parse(mergeGitlabCi(undefined, plan));
    expect(out.stages).toEqual(['build', 'daas-staging', 'daas-production']);
    expect(out.build.stage).toBe('build');
    expect(out.include).toHaveLength(3);
  });

  it('keeps the existing file, its comments and other includes, and replaces old DAAS includes', () => {
    const existing = [
      '# my pipeline',
      'stages: [test, build]',
      'include:',
      '  - local: ci/lint.yml',
      '  - component: $CI_SERVER_FQDN/platform/daas-components/deploy@1.0.0',
      '    inputs: { environment: production }',
      'test:',
      '  stage: test',
      '  script: [make test]',
      '',
    ].join('\n');
    const text = mergeGitlabCi(existing, plan);
    expect(text).toContain('# my pipeline');
    const out = parse(text);
    expect(out.stages).toEqual(['test', 'build', 'daas-staging', 'daas-production']);
    expect(out.test.script).toEqual(['make test']);
    expect(out.include[0]).toEqual({ local: 'ci/lint.yml' });
    expect(out.include.filter((i: any) => String(i.component).includes('@1.0.0'))).toHaveLength(0);
    expect(out.include).toHaveLength(4);
  });

  it('accepts a single include written as a string', () => {
    const out = parse(mergeGitlabCi('include: ci/base.yml\n', plan));
    expect(out.include[0]).toBe('ci/base.yml');
  });

  it('refuses invalid YAML', () => {
    expect(() => mergeGitlabCi('stages: [a\n', plan)).toThrow(/not valid YAML/);
  });
});
