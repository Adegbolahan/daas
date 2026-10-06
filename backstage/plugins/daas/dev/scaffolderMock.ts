import type { Entity } from '@backstage/catalog-model';
import {
  APP_SPEC_HEADER,
  buildTemplates,
  formValuesToSpec,
  formValuesToTeamFiles,
  toYaml,
} from '@internal/plugin-daas-common';
import type { LogEvent, ScaffolderApi, ScaffolderTask } from '@backstage/plugin-scaffolder-common';
import ObservableImpl from 'zen-observable';
import { MockDaasApi, platform, schemas } from './fixtures';

const settings = {
  daasBaseUrl: 'https://daas.acme.io',
  owner: 'group:default/platform',
  gitlabHost: 'gitlab.acme.io',
  platformRepoUrl: 'gitlab.acme.io?owner=platform&repo=daas',
};

/** The DAAS templates exactly as the backend's catalog module would generate them. */
export function daasTemplates(): Entity[] {
  return buildTemplates(schemas, platform, settings);
}

type Step = { id: string; name: string; action: string };
type Run = { task: ScaffolderTask; events: LogEvent[] };

/**
 * A scaffolder that runs the DAAS templates against the mock DAAS API: it renders daas.yaml or the
 * team files, validates like the real actions, and "opens" a merge request. Nothing leaves the browser.
 */
export class MockScaffolderApi implements Partial<ScaffolderApi> {
  private runs = new Map<string, Run>();
  constructor(private readonly daas: MockDaasApi) {}

  async getTemplateParameterSchema(templateRef: string) {
    const name = templateRef.split('/').pop();
    const t = daasTemplates().find(e => e.metadata.name === name);
    if (!t) throw new Error(`no template ${templateRef}`);
    const params = (t.spec as { parameters: Record<string, any>[] }).parameters;
    return {
      title: t.metadata.title ?? t.metadata.name,
      description: t.metadata.description,
      steps: params.map(({ title, description, ...schema }) => ({ title, description, schema })),
    } as any;
  }

  async scaffold({ templateRef, values }: { templateRef: string; values: Record<string, any> }) {
    const id = `task-${Date.now()}`;
    const onboarding = templateRef.endsWith('daas-onboard-team');
    const steps: Step[] = onboarding
      ? [
          { id: 'team', name: 'Write the team folder', action: 'daas:team:write' },
          { id: 'mr', name: 'Open merge request', action: 'publish:gitlab:merge-request' },
        ]
      : [
          { id: 'spec', name: 'Write daas.yaml', action: 'daas:spec:write' },
          { id: 'mr', name: 'Open merge request', action: 'publish:gitlab:merge-request' },
        ];
    const events: LogEvent[] = [];
    let n = 0;
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const log = (stepId: string | undefined, message: string, status?: any, extra: object = {}) =>
      events.push({
        id: n++,
        taskId: id,
        type: 'log',
        createdAt: at(n * 300),
        body: { message, stepId, ...(status ? { status } : {}) },
        ...extra,
      } as LogEvent);

    let output: Record<string, unknown> = {};
    let error: { name: string; message: string } | undefined;
    try {
      if (onboarding) {
        const files = formValuesToTeamFiles(values);
        log('team', 'Beginning step Write the team folder', 'processing');
        for (const f of ['access', 'clusters', 'secrets'] as const) {
          log('team', `platform/teams/${files.team}/${f}.yaml\n${toYaml(files[f])}`);
        }
        log('team', 'Finished step', 'completed');
        output = mrOutput(`platform/daas`, `onboard-${files.team}`, [
          { title: 'Team in DAAS', url: `/daas/teams/${files.team}` },
        ]);
      } else {
        const spec = formValuesToSpec(values, (await this.daas.schemas()).app);
        const yaml = toYaml(spec, APP_SPEC_HEADER);
        log('spec', 'Beginning step Write daas.yaml', 'processing');
        const preview = await this.daas.preview({
          spec: yaml,
          team: String(values.team),
          environment: String(values.environment ?? 'production'),
        });
        if (!preview.valid) throw new Error(`DAAS rejected daas.yaml: ${preview.errors.join('; ')}`);
        log('spec', `wrote daas.yaml\n${yaml}`);
        log('spec', `wrote catalog-info.yaml with daas.io/app: ${values.team}/${spec.name}`);
        if (templateRef.endsWith('daas-create-app')) log('spec', 'created .gitlab-ci.yml with the DAAS includes');
        log('spec', 'Finished step', 'completed');
        output = mrOutput(String(values.repoUrl ?? ''), `update-${spec.name}`, [
          { title: 'App in DAAS', url: `/daas/apps/${values.team}/${spec.name}` },
        ]);
      }
      log('mr', 'Beginning step Open merge request', 'processing');
      log('mr', 'Merge request !128 opened (simulated)');
      log('mr', 'Finished step', 'completed');
    } catch (e) {
      error = { name: 'InputError', message: (e as Error).message };
      const failed = onboarding ? 'team' : 'spec';
      log(failed, (e as Error).message);
      log(failed, 'Step failed', 'failed');
    }
    events.push({
      id: n++,
      taskId: id,
      type: 'completion',
      createdAt: at(n * 300),
      body: { message: error ? 'Run failed' : 'Run completed', status: error ? 'failed' : 'completed', output, error },
    } as unknown as LogEvent);

    this.runs.set(id, {
      events,
      task: {
        id,
        status: error ? 'failed' : 'completed',
        createdAt: new Date().toISOString(),
        spec: {
          apiVersion: 'scaffolder.backstage.io/v1beta3',
          steps: steps.map(s => ({ ...s, input: {} })),
          output: {},
          parameters: values,
          templateInfo: { entityRef: templateRef },
        } as any,
      },
    });
    return { taskId: id };
  }

  async getTask(taskId: string) {
    const run = this.runs.get(taskId);
    if (!run) throw new Error(`no task ${taskId}`);
    return run.task;
  }

  streamLogs({ taskId }: { taskId: string }) {
    return new ObservableImpl<LogEvent>(sub => {
      const events = this.runs.get(taskId)?.events ?? [];
      const timers = events.map((e, i) => setTimeout(() => sub.next(e), 250 * (i + 1)));
      return () => timers.forEach(clearTimeout);
    });
  }

  async listTasks() {
    return { tasks: [...this.runs.values()].map(r => r.task), totalTasks: this.runs.size };
  }

  async getIntegrationsList() {
    return { integrations: [{ type: 'gitlab', title: 'gitlab.acme.io', host: 'gitlab.acme.io' }] };
  }

  async listActions() {
    return [];
  }

  async autocomplete() {
    return { results: [] };
  }
}

function mrOutput(repo: string, branch: string, links: { title: string; url: string }[]) {
  return {
    links: [
      {
        title: 'Merge request (simulated)',
        url: `https://gitlab.acme.io/-/merge_requests/128?branch=${branch}&repo=${encodeURIComponent(repo)}`,
      },
      ...links,
    ],
  };
}
