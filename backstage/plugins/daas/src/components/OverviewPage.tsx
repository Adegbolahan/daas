import { Alert, Link, Text } from '@backstage/ui';
import { RiApps2Line, RiArrowRightSLine, RiRocketLine, RiServerLine, RiTeamLine } from '@remixicon/react';
import type { PlatformView, StageView } from '@internal/plugin-daas-common';
import { useMemo } from 'react';
import { allClusters, isActive, stageIndex } from '../data';
import { timeAgo } from '../format';
import { useDaas, useInterval } from '../hooks';
import { useLinks } from '../routes';
import { useScope } from '../scope';
import { TeamCard } from './TeamsPage';
import { CloudBadge, DataTable, ErrorState, LoadingBlock, Mono, Section, Stat, StatusBadge } from './ui';

const DAY = 24 * 3600 * 1000;

export function OverviewPage() {
  const links = useLinks();
  const platform = useDaas(api => api.platform(), []);
  const apps = useDaas(api => api.apps(), []);
  const deployments = useDaas(api => api.deployments({ limit: 200 }), []);
  useInterval(deployments.reload, deployments.value?.some(isActive) ? 5000 : null);
  const { inScope, mode } = useScope();

  // Everything below shows the user's teams, or all of them (the scope switch in the header).
  const scoped = useMemo(
    () => ({
      platform: platform.value && { ...platform.value, teams: platform.value.teams.filter(t => inScope(t.name)) },
      apps: apps.value?.filter(a => inScope(a.team)),
      deployments: deployments.value?.filter(d => inScope(d.team)),
    }),
    [platform.value, apps.value, deployments.value, inScope],
  );

  const stats = useMemo(() => {
    const clusters = allClusters(scoped.platform);
    const recent = (scoped.deployments ?? []).filter(d => Date.now() - new Date(d.createdAt).getTime() < DAY);
    const finished = (scoped.deployments ?? [])
      .filter(d => d.status === 'succeeded' || d.status === 'failed')
      .slice(0, 50);
    const ok = finished.filter(d => d.status === 'succeeded').length;
    return {
      clusters,
      gke: clusters.filter(c => c.provider === 'gke').length,
      eks: clusters.filter(c => c.provider === 'eks').length,
      recent: recent.length,
      failedRecent: recent.filter(d => d.status === 'failed').length,
      active: (scoped.deployments ?? []).filter(isActive).length,
      successRate: finished.length ? Math.round((ok / finished.length) * 100) : undefined,
      finished: finished.length,
    };
  }, [scoped]);

  if (platform.error) return <ErrorState error={platform.error} onRetry={platform.reload} />;
  if (!platform.value) return <LoadingBlock rows={6} />;
  const p = scoped.platform!;
  const scopedApps = scoped.apps;

  return (
    <div className="daas-stack">
      {p.configError && (
        <Alert
          status="warning"
          icon
          title="DAAS is serving the last good platform config"
          description={`The latest change in the platform repository didn’t load: ${p.configError}`}
        />
      )}

      <div className="daas-stats">
        <Stat
          label={mode === 'mine' ? 'Your teams' : 'Teams'}
          icon={<RiTeamLine size={16} />}
          value={p.teams.length}
          hint={`${p.stages.length} stages`}
        />
        <Stat
          label="Apps"
          icon={<RiApps2Line size={16} />}
          value={scopedApps?.length ?? '—'}
          hint={scopedApps ? `${scopedApps.reduce((n, a) => n + a.environments.length, 0)} running environments` : ' '}
        />
        <Stat
          label="Clusters"
          icon={<RiServerLine size={16} />}
          value={stats.clusters.length}
          hint={`${stats.gke} GKE · ${stats.eks} EKS`}
        />
        <Stat
          label="Deployments, last 24 h"
          icon={<RiRocketLine size={16} />}
          value={scoped.deployments ? stats.recent : '—'}
          hint={
            stats.successRate === undefined
              ? stats.active
                ? `${stats.active} rolling out`
                : 'None finished yet'
              : `${stats.successRate}% of the last ${stats.finished} succeeded${stats.active ? ` · ${stats.active} rolling out` : ''}`
          }
        />
      </div>

      <Section
        title="Promotion path"
        description="Stages in the order they’re declared in stages.yaml. GitLab environment names route to a stage."
      >
        <StagePipeline platform={p} />
      </Section>

      <div className="daas-split">
        <Section
          title="Recent deployments"
          actions={
            <Link href={links.deployments()} variant="body-small">
              All deployments
            </Link>
          }
        >
          {deployments.error ? (
            <ErrorState error={deployments.error} onRetry={deployments.reload} />
          ) : !scoped.deployments ? (
            <LoadingBlock />
          ) : (
            <DataTable
              rows={scoped.deployments.slice(0, 8)}
              rowKey={d => d.id}
              empty={
                <Text color="secondary">No deployments yet. They appear here as soon as a pipeline calls DAAS.</Text>
              }
              columns={[
                {
                  key: 'app',
                  label: 'App',
                  render: d => (
                    <Link href={links.app(d.team, d.app)} weight="bold">
                      {d.app}
                    </Link>
                  ),
                },
                { key: 'env', label: 'Environment', render: d => <Mono>{d.environment}</Mono> },
                { key: 'status', label: 'Status', render: d => <StatusBadge status={d.status} /> },
                {
                  key: 'when',
                  label: 'When',
                  align: 'right',
                  render: d => (
                    <Text variant="body-small" color="secondary">
                      {timeAgo(d.createdAt)}
                    </Text>
                  ),
                },
              ]}
            />
          )}
        </Section>

        <Section
          title="Teams"
          actions={
            <Link href={links.teams} variant="body-small">
              All teams
            </Link>
          }
        >
          <div className="daas-list">
            {p.teams.slice(0, 6).map(t => (
              <TeamCard key={t.name} team={t} platform={p} apps={scopedApps} compact />
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

export function StagePipeline({ platform }: { platform: PlatformView }) {
  const order = stageIndex(platform);
  const clusters = allClusters(platform);
  const stages = [...platform.stages].sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  return (
    <ol className="daas-pipeline">
      {stages.map((s, i) => (
        <li key={s.name} className="daas-pipeline__item">
          <StageCard stage={s} clusters={clusters.filter(c => c.stage === s.name)} />
          {i < stages.length - 1 && <RiArrowRightSLine className="daas-pipeline__arrow" aria-hidden size={20} />}
        </li>
      ))}
    </ol>
  );
}

function StageCard({
  stage,
  clusters,
}: {
  stage: StageView;
  clusters: { provider: 'gke' | 'eks'; region: string; name: string }[];
}) {
  const regions = [...new Map(clusters.map(c => [`${c.provider}/${c.region}`, c])).values()];
  const flags = [
    stage.preview && 'Previews',
    stage.autoApply && 'Auto-apply',
    stage.allowStop && 'Stoppable',
    stage.partialTargets && 'Partial targets',
  ].filter(Boolean) as string[];
  return (
    <div className="daas-stagecard">
      <div className="daas-stagecard__head">
        <Text variant="body-medium" weight="bold">
          {stage.name}
        </Text>
        <span className="daas-tier" title="GitLab deployment tier">
          {stage.gitlabTier}
        </span>
      </div>
      <div className="daas-stagecard__envs">
        {stage.environments.map(e => (
          <Mono key={e}>{e}</Mono>
        ))}
      </div>
      <div className="daas-stagecard__clusters">
        {regions.length ? (
          regions.map(c => <CloudBadge key={`${c.provider}/${c.region}`} provider={c.provider} region={c.region} />)
        ) : (
          <Text variant="body-x-small" color="secondary">
            No clusters yet
          </Text>
        )}
      </div>
      <Text variant="body-x-small" color="secondary">
        {clusters.length} cluster{clusters.length === 1 ? '' : 's'}
        {flags.length ? ` · ${flags.join(' · ')}` : ''}
      </Text>
    </div>
  );
}
