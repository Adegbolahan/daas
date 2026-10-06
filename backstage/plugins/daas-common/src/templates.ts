import type { Entity } from '@backstage/catalog-model';
import { appFormSteps, teamFormSteps } from './schemaToForm';
import type { DaasSchemas, PlatformView } from './types';

export interface TemplateSettings {
  daasBaseUrl: string;
  owner: string;
  gitlabHost: string;
  platformRepoUrl: string;
}

const managedBy = (s: TemplateSettings) => `url:${s.daasBaseUrl}/v1/schemas`;

function template(
  s: TemplateSettings,
  name: string,
  title: string,
  description: string,
  tags: string[],
  spec: Record<string, unknown>,
): Entity {
  return {
    apiVersion: 'scaffolder.backstage.io/v1beta3',
    kind: 'Template',
    metadata: {
      name,
      title,
      description,
      tags: ['daas', ...tags],
      annotations: {
        'backstage.io/managed-by-location': managedBy(s),
        'backstage.io/managed-by-origin-location': managedBy(s),
        'daas.io/generated-from': 'schemas',
      },
      links: [{ url: '/daas', title: 'DAAS', icon: 'dashboard' }],
    },
    spec: { owner: s.owner, type: 'daas', ...spec },
  };
}

/**
 * The DAAS Scaffolder templates, generated from the DAAS schemas and platform view. Regenerated on
 * a schedule, so a new schema field, stage or team shows up without anyone editing a template.
 */
export function buildTemplates(schemas: DaasSchemas, platform: PlatformView, s: TemplateSettings): Entity[] {
  const appSteps = (mode: 'create' | 'update') =>
    appFormSteps(schemas.app, {
      platform,
      repository: { allowedHosts: [s.gitlabHost], mode },
      review: true,
    });

  const specStep = (mode: 'create' | 'update') => ({
    id: 'spec',
    name: mode === 'create' ? 'Write daas.yaml and CI' : 'Update daas.yaml',
    action: 'daas:spec:write',
    input: {
      values: '${{ parameters }}',
      mode,
      repoUrl: '${{ parameters.repoUrl }}',
      branch: '${{ parameters.branch }}',
      ...(mode === 'create' ? { addCiInclude: '${{ parameters.addCiInclude }}' } : {}),
    },
  });

  const mrStep = (mode: 'create' | 'update') => ({
    id: 'mr',
    name: 'Open merge request',
    action: 'publish:gitlab:merge-request',
    input: {
      repoUrl: '${{ parameters.repoUrl }}',
      title: mode === 'create' ? 'DAAS: deploy ${{ parameters.name }}' : 'DAAS: update ${{ parameters.name }}',
      description: '${{ steps.spec.output.summary }}',
      branchName: '${{ steps.spec.output.branch }}',
      targetBranchName: '${{ parameters.branch }}',
      removeSourceBranch: true,
      labels: ['daas'],
    },
  });

  const appOutput = {
    links: [
      { title: 'Merge request', icon: 'github', url: '${{ steps.mr.output.mergeRequestUrl }}' },
      { title: 'App in DAAS', icon: 'dashboard', url: '/daas/apps/${{ parameters.team }}/${{ parameters.name }}' },
    ],
    text: [{ title: 'What happens next', content: '${{ steps.spec.output.summary }}' }],
  };

  return [
    template(
      s,
      'daas-create-app',
      'Deploy an app with DAAS',
      'Describe your app once and DAAS runs it in every stage your team uses: previews per MR, then each stage in order. Opens a merge request with daas.yaml, the catalog-info.yaml annotation and the CI components.',
      ['recommended', 'deploy'],
      { parameters: appSteps('create'), steps: [specStep('create'), mrStep('create')], output: appOutput },
    ),
    template(
      s,
      'daas-update-app',
      'Change a DAAS app',
      'Edit an app’s daas.yaml with a form, checked by DAAS before the merge request is opened. Open it from the app page in DAAS to start from the deployed configuration.',
      ['deploy'],
      { parameters: appSteps('update'), steps: [specStep('update'), mrStep('update')], output: appOutput },
    ),
    template(
      s,
      'daas-onboard-team',
      'Onboard a team to DAAS',
      'Create the team’s folder in the platform repo (access, clusters, secrets). Opens a merge request reviewed by the platform team.',
      ['platform'],
      {
        parameters: teamFormSteps(schemas, platform).map(step =>
          step.properties.repoUrl
            ? {
                ...step,
                properties: {
                  ...step.properties,
                  repoUrl: {
                    ...step.properties.repoUrl,
                    default: s.platformRepoUrl,
                    'ui:options': { allowedHosts: [s.gitlabHost] },
                  },
                },
              }
            : step,
        ),
        steps: [
          {
            id: 'team',
            name: 'Write the team folder',
            action: 'daas:team:write',
            input: { values: '${{ parameters }}' },
          },
          {
            id: 'mr',
            name: 'Open merge request',
            action: 'publish:gitlab:merge-request',
            input: {
              repoUrl: '${{ parameters.repoUrl }}',
              title: 'DAAS: onboard team ${{ parameters.teamName }}',
              description: '${{ steps.team.output.summary }}',
              branchName: '${{ steps.team.output.branch }}',
              targetBranchName: '${{ parameters.branch }}',
              removeSourceBranch: true,
              assignReviewersFromApprovalRules: true,
              labels: ['daas', 'onboarding'],
            },
          },
        ],
        output: {
          links: [
            { title: 'Merge request', icon: 'github', url: '${{ steps.mr.output.mergeRequestUrl }}' },
            { title: 'Team in DAAS (after merge)', icon: 'group', url: '/daas/teams/${{ parameters.teamName }}' },
          ],
        },
      },
    ),
  ];
}
