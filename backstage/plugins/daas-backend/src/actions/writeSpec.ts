import { LoggerService, UrlReaderService } from '@backstage/backend-plugin-api';
import { InputError, NotFoundError } from '@backstage/errors';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { APP_SPEC_HEADER, DaasSchemas, formValuesToSpec, PlatformView, toYaml } from '@internal/plugin-daas-common';
import fs from 'fs/promises';
import path from 'path';
import { DaasClient } from '../service/DaasClient';
import { upsertCatalogInfo } from './catalogInfo';
import { CiSettings, daasIncludes, mergeGitlabCi } from './ci';

export function parseGitlabRepoUrl(repoUrl: string): { host: string; project: string } {
  const [host, query = ''] = repoUrl.split('?');
  const q = new URLSearchParams(query);
  const owner = q.get('owner');
  const repo = q.get('repo');
  if (!host || !owner || !repo) throw new InputError(`not a GitLab repoUrl: ${repoUrl}`);
  return { host, project: `${owner}/${repo}` };
}

async function readRepoFile(reader: UrlReaderService, repoUrl: string, branch: string, file: string) {
  const { host, project } = parseGitlabRepoUrl(repoUrl);
  const url = `https://${host}/${project}/-/blob/${encodeURIComponent(branch)}/${file}`;
  try {
    const res = await reader.readUrl(url);
    return (await res.buffer()).toString('utf8');
  } catch (e) {
    if ((e as Error).name === NotFoundError.name || /not found|404/i.test((e as Error).message)) return undefined;
    throw e;
  }
}

export function branchName(prefix: string, name: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return `daas/${prefix}-${name}-${stamp}`;
}

function summaryFor(
  preview: Awaited<ReturnType<DaasClient['preview']>>,
  spec: Record<string, unknown>,
  environment: string,
  team: string,
): string {
  const lines = [
    `DAAS checked this change for team **${team}** against **${environment}** (stage \`${preview.stage}\`).`,
    '',
    '| cluster | wave | public hosts |',
    '|---|---|---|',
    ...preview.plan.map(
      p => `| \`${p.cluster}\` (${p.provider}, ${p.region}) | ${p.wave} | ${p.hosts.join(', ') || '—'} |`,
    ),
  ];
  if (preview.skippedTargets.length) lines.push('', `Skipped in this stage: ${preview.skippedTargets.join(', ')}`);
  if (preview.warnings.length) lines.push('', ...preview.warnings.map(w => `- ⚠️ ${w}`));
  if (preview.missingSecrets.length) {
    lines.push(
      '',
      'Set these secrets before the first deploy to this stage:',
      ...preview.missingSecrets.map(m => `- \`${m.name}\` (${m.provider})`),
    );
  }
  lines.push(
    '',
    `Kind: \`${spec.schedule ? 'cronjob' : spec.port ? 'service' : 'worker'}\`. Merging starts the pipeline.`,
  );
  return lines.join('\n');
}

export function createWriteSpecAction(deps: {
  client: DaasClient;
  reader: UrlReaderService;
  logger: LoggerService;
  ci: CiSettings;
}) {
  const { client, reader, ci } = deps;
  let cache: { at: number; schemas: DaasSchemas; platform: PlatformView } | undefined;
  const load = async () => {
    if (!cache || Date.now() - cache.at > 60_000) {
      const [schemas, platform] = await Promise.all([client.getSchemas(), client.getPlatform()]);
      cache = { at: Date.now(), schemas, platform };
    }
    return cache;
  };

  return createTemplateAction({
    id: 'daas:spec:write',
    description:
      'Turns DAAS form values into daas.yaml, has DAAS validate and plan it for the team, and writes it ' +
      '(plus the DAAS CI includes when creating) into the workspace for a merge request.',
    supportsDryRun: true,
    schema: {
      input: {
        values: z => z.record(z.unknown()).describe('The template parameters'),
        mode: z => z.enum(['create', 'update']),
        repoUrl: z => z.string(),
        branch: z => z.string().default('main'),
        addCiInclude: z => z.boolean().optional(),
        path: z => z.string().default('daas.yaml'),
        catalogInfo: z =>
          z.boolean().default(true).describe('Add daas.io/app to catalog-info.yaml (creating it if missing)'),
      },
      output: {
        spec: z => z.string(),
        summary: z => z.string(),
        branch: z => z.string(),
      },
    },
    async handler(ctx) {
      const { values, mode, repoUrl, branch, addCiInclude, path: specPath, catalogInfo } = ctx.input;
      const team = String(values.team ?? '');
      const environment = String(values.environment ?? 'production');
      const { schemas, platform } = await load();
      const teamView = platform.teams.find(t => t.name === team);
      if (!teamView) throw new InputError(`unknown team '${team}'`);

      const spec = formValuesToSpec(values, schemas.app);
      const yamlText = toYaml(spec, APP_SPEC_HEADER);
      const preview = await client.preview({ spec: yamlText, team, environment });
      if (!preview.valid) throw new InputError(`DAAS rejected daas.yaml: ${preview.errors.join('; ')}`);

      await fs.writeFile(path.join(ctx.workspacePath, specPath), yamlText, 'utf8');
      ctx.logger.info(`wrote ${specPath} for ${team}/${String(spec.name)}`);

      if (catalogInfo !== false) {
        const { project } = parseGitlabRepoUrl(repoUrl);
        const current = await readRepoFile(reader, repoUrl, branch, 'catalog-info.yaml');
        const next = upsertCatalogInfo(current, { name: String(spec.name), team, project, kind: preview.kind });
        if (next) {
          await fs.writeFile(path.join(ctx.workspacePath, 'catalog-info.yaml'), next, 'utf8');
          ctx.logger.info(
            `${current ? 'annotated' : 'created'} catalog-info.yaml (daas.io/app: ${team}/${String(spec.name)})`,
          );
        }
      }

      if (mode === 'create' && addCiInclude !== false) {
        const current = await readRepoFile(reader, repoUrl, branch, '.gitlab-ci.yml');
        const merged = mergeGitlabCi(current, daasIncludes(platform, teamView, ci));
        await fs.writeFile(path.join(ctx.workspacePath, '.gitlab-ci.yml'), merged, 'utf8');
        ctx.logger.info(current ? 'added the DAAS includes to .gitlab-ci.yml' : 'created .gitlab-ci.yml');
      }

      ctx.output('spec', yamlText);
      ctx.output('summary', summaryFor(preview, spec, environment, team));
      ctx.output('branch', branchName(mode === 'create' ? 'add' : 'update', String(spec.name)));
    },
  });
}
