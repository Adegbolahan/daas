import { Document, isMap, isSeq, parseDocument, YAMLSeq } from 'yaml';
import { PlatformView, TeamView } from '@internal/plugin-daas-common';

export interface CiSettings {
  componentProject: string;
  componentVersion: string;
  apiUrl: string;
}

/** A plain environment name for a stage: its first non-glob route, or the stage name. */
export function environmentFor(stage: PlatformView['stages'][number]): string {
  return stage.environments.find(e => !/[*?[]/.test(e)) ?? stage.name;
}

/**
 * The DAAS includes for an app: a preview per MR (if the team uses the preview stage), then one
 * deploy per stage the team enables, in platform order, each in its own CI stage so they run in
 * sequence. Production-like stages are protected in GitLab, which holds the job for approval.
 */
export function daasIncludes(platform: PlatformView, team: TeamView, ci: CiSettings) {
  const base = `$CI_SERVER_FQDN/${ci.componentProject}`;
  const includes: Record<string, unknown>[] = [];
  const ciStages: string[] = [];
  for (const stage of platform.stages) {
    if (!(stage.name in team.stages)) continue;
    if (stage.preview) {
      includes.push({
        component: `${base}/review@${ci.componentVersion}`,
        inputs: { api_url: ci.apiUrl },
      });
      continue;
    }
    const ciStage = `daas-${stage.name}`;
    ciStages.push(ciStage);
    includes.push({
      component: `${base}/deploy@${ci.componentVersion}`,
      inputs: {
        environment: environmentFor(stage),
        tier: stage.gitlabTier,
        stage: ciStage,
        api_url: ci.apiUrl,
      },
      rules: [{ if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }],
    });
  }
  return { includes, ciStages };
}

const BUILD_JOB = {
  stage: 'build',
  image: 'docker:27',
  services: ['docker:27-dind'],
  script: [
    'docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"',
    'docker build -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" .',
    'docker push "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA"',
  ],
  rules: [{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }, { if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }],
};

function componentId(c: unknown): string | undefined {
  const s = isMap(c) ? String(c.get('component') ?? '') : (c as { component?: string })?.component;
  return s ? s.replace(/@.*$/, '').replace(/\/(deploy|review)$/, '/$1') : undefined;
}

/**
 * Add the DAAS includes to an existing .gitlab-ci.yml (comments and the rest of the file are kept),
 * or create one with a build job when there is none. Existing DAAS includes are replaced.
 */
export function mergeGitlabCi(existing: string | undefined, plan: ReturnType<typeof daasIncludes>): string {
  const doc: Document = existing ? parseDocument(existing) : new Document({});
  if (doc.errors.length) throw new Error(`.gitlab-ci.yml is not valid YAML: ${doc.errors[0].message}`);
  if (!existing) {
    doc.commentBefore = ' CI for this app. Build the image, then DAAS deploys it (added by Backstage).';
    doc.set('build', doc.createNode(BUILD_JOB));
  }

  // stages: keep the user's, make sure build + ours exist in order
  const stagesNode = doc.get('stages');
  const stages: string[] = isSeq(stagesNode) ? (stagesNode.toJSON() as string[]) : [];
  for (const s of ['build', ...plan.ciStages]) if (!stages.includes(s)) stages.push(s);
  doc.set('stages', doc.createNode(stages, { flow: true }));

  // include: normalize to a list, drop previous DAAS components, add ours
  const inc = doc.get('include');
  let list: unknown[] = [];
  if (isSeq(inc)) list = (inc as YAMLSeq).items;
  else if (inc !== undefined) list = [inc];
  const ours = new Set(plan.includes.map(i => componentId(i)));
  const kept = list.filter(i => !ours.has(componentId(i)) || componentId(i) === undefined);
  doc.set('include', doc.createNode([...kept.map(i => (isMap(i) ? i.toJSON() : i)), ...plan.includes]));
  return doc.toString({ lineWidth: 0 });
}
