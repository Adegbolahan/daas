import { InputError } from '@backstage/errors';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { DaasSchemas, formValuesToTeamFiles, toYaml } from '@internal/plugin-daas-common';
import Ajv2020 from 'ajv/dist/2020';
import fs from 'fs/promises';
import path from 'path';
import { DaasClient } from '../service/DaasClient';
import { branchName } from './writeSpec';

const HEADERS = {
  access: (t: string) =>
    `# Access for team "${t}": who can deploy, where, and under which gates.\n` +
    `# Changes need approval from \`owners\` and the platform team (CODEOWNERS). Created in Backstage.`,
  clusters: (t: string) => `# ${t}'s dedicated clusters. Names start with "${t}-".`,
  secrets: (t: string) => `# Where ${t}'s secrets live by default, and who may write them (Entra ID).`,
};

export function validateTeamFiles(schemas: DaasSchemas, files: ReturnType<typeof formValuesToTeamFiles>): string[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const errors: string[] = [];
  const check = (name: string, schema: object, data: unknown) => {
    const validate = ajv.compile(schema);
    if (!validate(data)) {
      for (const e of validate.errors ?? []) errors.push(`${name}${e.instancePath || ''}: ${e.message}`);
    }
  };
  if (!/^[a-z]([-a-z0-9]{0,19}[a-z0-9])?$/.test(files.team)) errors.push('team name must be a short DNS label');
  check('access.yaml', schemas.teamAccess, files.access);
  check('clusters.yaml', schemas.teamClusters, files.clusters);
  check('secrets.yaml', schemas.teamSecrets, files.secrets);
  for (const c of files.clusters) {
    if (typeof c.name === 'string' && !c.name.startsWith(`${files.team}-`)) {
      errors.push(`clusters.yaml: '${c.name}' must start with '${files.team}-'`);
    }
  }
  return errors;
}

export function createWriteTeamAction(deps: { client: DaasClient; platformDir: string }) {
  return createTemplateAction({
    id: 'daas:team:write',
    description:
      'Writes platform/teams/<team>/{access,clusters,secrets}.yaml from the onboarding form, validated against the DAAS schemas.',
    supportsDryRun: true,
    schema: {
      input: { values: z => z.record(z.unknown()) },
      output: { summary: z => z.string(), branch: z => z.string(), path: z => z.string() },
    },
    async handler(ctx) {
      const schemas = await deps.client.getSchemas();
      const platform = await deps.client.getPlatform();
      const files = formValuesToTeamFiles(ctx.input.values);
      const errors = validateTeamFiles(schemas, files);
      if (platform.teams.some(t => t.name === files.team)) errors.push(`team '${files.team}' already exists`);
      if (errors.length) throw new InputError(errors.join('; '));

      const dir = path.join(ctx.workspacePath, deps.platformDir, 'teams', files.team);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'access.yaml'), toYaml(files.access, HEADERS.access(files.team)));
      await fs.writeFile(path.join(dir, 'clusters.yaml'), toYaml(files.clusters, HEADERS.clusters(files.team)));
      await fs.writeFile(path.join(dir, 'secrets.yaml'), toYaml(files.secrets, HEADERS.secrets(files.team)));

      const stages = Object.keys(files.access.stages as object);
      ctx.output('path', `${deps.platformDir}/teams/${files.team}`);
      ctx.output('branch', branchName('onboard', files.team));
      ctx.output(
        'summary',
        [
          `Onboards team **${files.team}** to DAAS.`,
          '',
          `- Stages: ${stages.map(s => `\`${s}\``).join(', ') || 'none yet'}`,
          `- Clusters: ${files.clusters.map(c => `\`${String(c.name)}\``).join(', ') || 'none yet'}`,
          `- GitLab projects: ${(files.access.projects as string[]).map(p => `\`${p}\``).join(', ')}`,
          '',
          'After merging: run `cd api && python -m daas_api.team --write` (CI checks it) so the team README and CODEOWNERS are regenerated; the DAAS pipeline then plans the team’s cloud identities per stage.',
        ].join('\n'),
      );
    },
  });
}
