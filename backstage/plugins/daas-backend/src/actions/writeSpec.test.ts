import { platform, schemas } from '@internal/plugin-daas-common/testing';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'yaml';
import { branchName, createWriteSpecAction, parseGitlabRepoUrl } from './writeSpec';

const okPreview = {
  valid: true,
  errors: [],
  warnings: [],
  skippedTargets: [],
  missingSecrets: [{ name: 'DB', provider: 'gcp' }],
  plan: [
    { cluster: 'payments-prod-euw1', provider: 'gke', region: 'europe-west1', wave: 1, hosts: ['svc.pay.acme.io'] },
  ],
  manifests: {},
  stage: 'production',
  name: 'svc',
  namespace: 'payments',
  kind: 'service',
};

function setup(preview: any = okPreview, existingCi?: string) {
  const client = {
    getSchemas: jest.fn(async () => schemas),
    getPlatform: jest.fn(async () => platform),
    preview: jest.fn(async () => preview),
  };
  const reader = {
    readUrl: jest.fn(async () => {
      if (existingCi === undefined) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      return { buffer: async () => Buffer.from(existingCi) };
    }),
  };
  const action = createWriteSpecAction({
    client: client as any,
    reader: reader as any,
    logger: { info: jest.fn() } as any,
    ci: { componentProject: 'platform/daas-components', componentVersion: '1.4.0', apiUrl: 'https://daas.acme.io' },
  });
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'daas-'));
  const outputs: Record<string, unknown> = {};
  const ctx = (input: Record<string, unknown>) =>
    ({ input, workspacePath, logger: { info: jest.fn() }, output: (k: string, v: unknown) => (outputs[k] = v) }) as any;
  return { action, client, reader, ctx, workspacePath, outputs };
}

const values = {
  team: 'payments',
  environment: 'production',
  repoUrl: 'gitlab.acme.io?owner=acme%2Fpayments&repo=svc',
  name: 'svc',
  port: 8080,
  targets: [{ provider: 'gke', region: 'europe-west1' }],
  previewSpec: 'ignored',
};

describe('daas:spec:write', () => {
  it('parses GitLab repo URLs and names branches', () => {
    expect(parseGitlabRepoUrl(values.repoUrl)).toEqual({ host: 'gitlab.acme.io', project: 'acme/payments/svc' });
    expect(branchName('add', 'svc', new Date('2026-09-24T10:11:12Z'))).toBe('daas/add-svc-202609241011');
  });

  it('writes daas.yaml and a new .gitlab-ci.yml on create', async () => {
    const t = setup();
    await t.action.handler(
      t.ctx({ values, mode: 'create', repoUrl: values.repoUrl, branch: 'main', path: 'daas.yaml' }),
    );
    const spec = parse(fs.readFileSync(path.join(t.workspacePath, 'daas.yaml'), 'utf8'));
    expect(spec).toEqual({
      apiVersion: 'daas/v1',
      name: 'svc',
      port: 8080,
      targets: [{ provider: 'gke', region: 'europe-west1' }],
    });
    const gitlabCi = parse(fs.readFileSync(path.join(t.workspacePath, '.gitlab-ci.yml'), 'utf8'));
    expect(gitlabCi.include).toHaveLength(3);
    expect(t.client.preview).toHaveBeenCalledWith(
      expect.objectContaining({ team: 'payments', environment: 'production' }),
    );
    expect(String(t.outputs.summary)).toContain('`DB` (gcp)');
    expect(String(t.outputs.branch)).toMatch(/^daas\/add-svc-/);
    const catalog = parse(fs.readFileSync(path.join(t.workspacePath, 'catalog-info.yaml'), 'utf8'));
    expect(catalog.metadata.annotations['daas.io/app']).toBe('payments/svc');
  });

  it('leaves .gitlab-ci.yml alone on update', async () => {
    const t = setup();
    await t.action.handler(
      t.ctx({ values, mode: 'update', repoUrl: values.repoUrl, branch: 'main', path: 'daas.yaml' }),
    );
    expect(fs.existsSync(path.join(t.workspacePath, '.gitlab-ci.yml'))).toBe(false);
    expect(t.reader.readUrl).not.toHaveBeenCalledWith(expect.stringContaining('.gitlab-ci.yml'));
    expect(fs.existsSync(path.join(t.workspacePath, 'catalog-info.yaml'))).toBe(true);
  });

  it('refuses a spec DAAS rejects, before writing anything', async () => {
    const t = setup({ ...okPreview, valid: false, errors: ["'targets' is required"] });
    await expect(
      t.action.handler(t.ctx({ values, mode: 'create', repoUrl: values.repoUrl, branch: 'main', path: 'daas.yaml' })),
    ).rejects.toThrow(/targets' is required/);
    expect(fs.existsSync(path.join(t.workspacePath, 'daas.yaml'))).toBe(false);
  });

  it('refuses unknown teams', async () => {
    const t = setup();
    await expect(
      t.action.handler(
        t.ctx({
          values: { ...values, team: 'nope' },
          mode: 'update',
          repoUrl: values.repoUrl,
          branch: 'main',
          path: 'daas.yaml',
        }),
      ),
    ).rejects.toThrow(/unknown team/);
  });
});
