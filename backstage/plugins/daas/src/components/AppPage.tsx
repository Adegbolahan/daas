import { ButtonLink, Link, Select, Text } from '@backstage/ui';
import { RiEditLine, RiExternalLinkLine, RiKey2Line, RiTimeLine } from '@remixicon/react';
import { specToFormValues } from '@internal/plugin-daas-common';
import type { AppEnvironment, DeploymentRecord, PlatformView } from '@internal/plugin-daas-common';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { parse } from 'yaml';
import { clusterLookup, isActive, stageIndex } from '../data';
import { shortImage, timeAgo } from '../format';
import { useDaas, useInterval } from '../hooks';
import { useLinks } from '../routes';
import { DeploymentList } from './DeploymentsPage';
import {
  CloudBadge,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Mono,
  Section,
  StagePill,
  StatusBadge,
  YamlBlock,
} from './ui';

export function AppPage() {
  const { team = '', app = '' } = useParams();
  return <AppDetail team={team} app={app} />;
}

/** Everything about one app. Also used as the "DAAS" tab on a catalog entity. */
export function AppDetail({ team, app, embedded }: { team: string; app: string; embedded?: boolean }) {
  const links = useLinks();
  const platform = useDaas(api => api.platform(), []);
  const apps = useDaas(api => api.apps(team), [team]);
  const deployments = useDaas(api => api.deployments({ team, app, limit: 50 }), [team, app]);
  useInterval(deployments.reload, deployments.value?.some(isActive) ? 4000 : null);

  const view = apps.value?.find(a => a.app === app);
  const project = view?.project ?? deployments.value?.[0]?.requestedBy?.project_path;
  const envs = useMemo(() => {
    const order = stageIndex(platform.value);
    return [...(view?.environments ?? [])].sort(
      (a, b) => Number(a.preview) - Number(b.preview) || (order.get(a.stage) ?? 0) - (order.get(b.stage) ?? 0),
    );
  }, [view, platform.value]);

  const [specEnv, setSpecEnv] = useState<string | undefined>();
  const spec = useDaas(api => api.appSpec(team, app, specEnv), [team, app, specEnv]);
  const schemas = useDaas(api => api.schemas(), []);
  const editHref = useMemo(() => {
    if (!spec.value || !schemas.value) return undefined;
    let values: Record<string, unknown> = {};
    try {
      values = specToFormValues(parse(spec.value.spec) ?? {}, schemas.value.app);
    } catch {
      /* fall back to an empty form */
    }
    return links.updateApp({
      ...values,
      team,
      repoUrl: links.repoUrl(spec.value.project ?? project),
      branch: 'main',
      environment: spec.value.environment,
    });
  }, [spec.value, schemas.value, links, team, project]);

  if (apps.error) return <ErrorState error={apps.error} onRetry={apps.reload} />;
  if (!apps.value || !deployments.value) return <LoadingBlock rows={8} />;
  if (!view && !deployments.value.length) {
    return (
      <EmptyState title={`No deployments of ${team}/${app} yet`}>
        It shows up here after the first pipeline deploys it through DAAS.
      </EmptyState>
    );
  }

  return (
    <div className="daas-stack">
      <div className="daas-titlebar">
        <div>
          {!embedded && (
            <Text as="h1" variant="title-medium" weight="bold">
              {app}
            </Text>
          )}
          <div className="daas-meta">
            <span>
              Team{' '}
              <Link href={links.team(team)} variant="body-small">
                {team}
              </Link>
            </span>
            <span>
              Kind <Mono>{view?.kind ?? deployments.value[0]?.kind ?? 'service'}</Mono>
            </span>
            {project && links.gitlabProject(project) && (
              <Link href={links.gitlabProject(project)!} target="_blank" variant="body-small">
                {project} <RiExternalLinkLine size={12} aria-hidden />
              </Link>
            )}
          </div>
        </div>
        <div className="daas-inline">
          <ButtonLink href={links.secrets({ team, app })} variant="secondary" size="small" iconStart={<RiKey2Line />}>
            Secrets
          </ButtonLink>
          {editHref && (
            <ButtonLink href={editHref} variant="primary" size="small" iconStart={<RiEditLine />}>
              Edit daas.yaml
            </ButtonLink>
          )}
        </div>
      </div>

      <Section title="Environments" description="What’s running where, from the GitOps repository.">
        {envs.length ? (
          <div className="daas-lanes">
            {envs.map(e => (
              <EnvironmentLane
                key={e.environment}
                env={e}
                platform={platform.value}
                deployment={deployments.value!.find(d => d.environment === e.environment)}
              />
            ))}
          </div>
        ) : (
          <Text color="secondary">Not running anywhere right now.</Text>
        )}
      </Section>

      <Section
        title="Deployment history"
        actions={
          <Link href={links.deployments({ team, app })} variant="body-small">
            Open in Deployments
          </Link>
        }
      >
        <DeploymentList deployments={deployments.value.slice(0, 15)} platform={platform.value} showApp={false} />
      </Section>

      <Section
        title="daas.yaml"
        description="As submitted by the latest deployment. Edit opens a merge request with your changes."
        actions={
          envs.length > 1 && (
            <Select
              aria-label="Environment"
              size="small"
              className="daas-toolbar__select"
              options={envs.map(e => ({ id: e.environment, label: e.environment }))}
              value={specEnv ?? spec.value?.environment ?? envs[0]?.environment}
              onChange={k => setSpecEnv(k ? String(k) : undefined)}
            />
          )
        }
      >
        {spec.error ? (
          <ErrorState error={spec.error} onRetry={spec.reload} />
        ) : !spec.value ? (
          <LoadingBlock />
        ) : (
          <YamlBlock text={spec.value.spec} />
        )}
      </Section>
    </div>
  );
}

function EnvironmentLane({
  env,
  platform,
  deployment,
}: {
  env: AppEnvironment;
  platform?: PlatformView;
  deployment?: DeploymentRecord;
}) {
  const clusters = clusterLookup(platform);
  const tier = platform?.stages.find(s => s.name === env.stage)?.gitlabTier;
  return (
    <div className={`daas-lane${env.preview ? ' daas-lane--preview' : ''}`}>
      <div className="daas-lane__head">
        <StagePill name={env.stage} tier={tier} preview={env.preview} />
        <Mono>{env.environment}</Mono>
        <span className="daas-lane__spacer" />
        {deployment && <StatusBadge status={deployment.status} />}
      </div>
      <div className="daas-lane__image" title={env.image ?? undefined}>
        <Text variant="body-x-small" color="secondary">
          Image
        </Text>
        <Mono>{shortImage(env.image)}</Mono>
      </div>
      <ul className="daas-lane__clusters">
        {env.clusters.map(c => {
          const info = clusters.get(c.cluster);
          const status = deployment?.clusters.find(x => x.cluster === c.cluster)?.status;
          return (
            <li key={c.cluster}>
              <div className="daas-inline">
                {info && <CloudBadge provider={info.provider} region={info.region} />}
                <Mono>{c.cluster}</Mono>
                {status && <StatusBadge status={status} />}
              </div>
              {c.hosts.map(h => (
                <Link key={h} href={`https://${h}`} target="_blank" variant="body-small" className="daas-host">
                  {h}
                </Link>
              ))}
            </li>
          );
        })}
      </ul>
      <div className="daas-lane__foot">
        <Text variant="body-x-small" color="secondary">
          Namespace <Mono>{env.namespace}</Mono>
          {deployment && ` · deployed ${timeAgo(deployment.createdAt)}`}
        </Text>
        {env.expiresAt && (
          <Text variant="body-x-small" color="warning" className="daas-inline">
            <RiTimeLine size={12} aria-hidden /> expires {new Date(env.expiresAt).toLocaleString()}
          </Text>
        )}
      </div>
    </div>
  );
}
