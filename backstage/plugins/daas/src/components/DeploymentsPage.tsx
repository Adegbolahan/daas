import { Link, SearchField, Select, Text } from '@backstage/ui';
import { RiArrowDownSLine, RiGitCommitLine, RiUserLine } from '@remixicon/react';
import type { DeploymentRecord, PlatformView } from '@internal/plugin-daas-common';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { clusterLookup, isActive } from '../data';
import { shortImage, timeAgo } from '../format';
import { useDaas, useInterval } from '../hooks';
import { useLinks } from '../routes';
import { useScope } from '../scope';
import { CloudBadge, EmptyState, ErrorState, LoadingBlock, Mono, StatusBadge } from './ui';

const ALL = '__all__';
const STATUSES = [
  { id: ALL, label: 'Any status' },
  { id: 'running', label: 'Rolling out' },
  { id: 'pending', label: 'Pending' },
  { id: 'succeeded', label: 'Succeeded' },
  { id: 'failed', label: 'Failed' },
];

export function DeploymentsPage() {
  const [params, setParams] = useSearchParams();
  const team = params.get('team') ?? '';
  const app = params.get('app') ?? '';
  const status = params.get('status') ?? '';
  const [env, setEnv] = useState(params.get('environment') ?? '');
  const platform = useDaas(api => api.platform(), []);
  const deployments = useDaas(
    api =>
      api.deployments({ team: team || undefined, app: app || undefined, environment: env || undefined, limit: 200 }),
    [team, app, env],
  );
  useInterval(deployments.reload, deployments.value?.some(isActive) ? 4000 : null);

  const set = (key: string, value?: string) => {
    const next = new URLSearchParams(params);
    if (!value || value === ALL) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };
  const { inScope } = useScope();
  const rows = (deployments.value ?? []).filter(d => (team || inScope(d.team)) && (!status || d.status === status));

  return (
    <div className="daas-stack">
      <div className="daas-toolbar">
        <Select
          aria-label="Team"
          size="small"
          className="daas-toolbar__select"
          options={[
            { id: ALL, label: 'All teams' },
            ...(platform.value?.teams ?? []).map(t => ({ id: t.name, label: t.name })),
          ]}
          value={team || ALL}
          onChange={k => set('team', String(k ?? ''))}
        />
        <Select
          aria-label="Status"
          size="small"
          className="daas-toolbar__select"
          options={STATUSES}
          value={status || ALL}
          onChange={k => set('status', String(k ?? ''))}
        />
        <SearchField
          aria-label="Environment"
          placeholder="Environment, e.g. production or review/mr-42"
          size="small"
          value={env}
          onChange={setEnv}
          onSubmit={v => set('environment', v)}
        />
        {app && (
          <Text variant="body-small" color="secondary">
            App <Mono>{app}</Mono> ·{' '}
            <Link href="#" onPress={() => set('app')} variant="body-small">
              clear
            </Link>
          </Text>
        )}
      </div>
      {deployments.error ? (
        <ErrorState error={deployments.error} onRetry={deployments.reload} />
      ) : !deployments.value ? (
        <LoadingBlock rows={8} />
      ) : (
        <DeploymentList deployments={rows} platform={platform.value} />
      )}
    </div>
  );
}

export function DeploymentList({
  deployments,
  platform,
  showApp = true,
}: {
  deployments: DeploymentRecord[];
  platform?: PlatformView;
  showApp?: boolean;
}) {
  if (!deployments.length) {
    return (
      <EmptyState title="No deployments">
        Deployments are recorded when a pipeline calls DAAS (the deploy and review CI components).
      </EmptyState>
    );
  }
  return (
    <ul className="daas-deploys">
      {deployments.map(d => (
        <DeploymentItem key={d.id} d={d} platform={platform} showApp={showApp} />
      ))}
    </ul>
  );
}

function DeploymentItem({ d, platform, showApp }: { d: DeploymentRecord; platform?: PlatformView; showApp: boolean }) {
  const links = useLinks();
  const [open, setOpen] = useState(d.status === 'failed' || isActive(d));
  const clusters = clusterLookup(platform);
  const waves = [...new Set(d.clusters.map(c => c.wave))].sort((a, b) => a - b);
  const done = d.clusters.filter(c => c.status === 'healthy' || c.status === 'committed').length;
  const by = d.requestedBy;
  return (
    <li className={`daas-deploy${open ? ' daas-deploy--open' : ''}`}>
      <button type="button" className="daas-deploy__summary" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <StatusBadge status={d.status} />
        <span className="daas-deploy__what">
          {showApp && <strong>{d.app}</strong>}
          <Mono>{d.environment}</Mono>
          {d.dryRun && <span className="daas-tier">dry run</span>}
        </span>
        <span className="daas-deploy__image">
          <Mono>{shortImage(d.image)}</Mono>
        </span>
        <span className="daas-deploy__progress" title={`${done} of ${d.clusters.length} clusters done`}>
          <span className="daas-progress" aria-hidden>
            <span style={{ width: `${d.clusters.length ? (done / d.clusters.length) * 100 : 0}%` }} />
          </span>
          <Text variant="body-x-small" color="secondary">
            {done}/{d.clusters.length}
          </Text>
        </span>
        <Text variant="body-small" color="secondary" className="daas-deploy__when">
          {timeAgo(d.createdAt)}
        </Text>
        <RiArrowDownSLine className="daas-deploy__chevron" aria-hidden size={18} />
      </button>
      {open && (
        <div className="daas-deploy__detail">
          <div className="daas-meta">
            {showApp && (
              <span>
                <Link href={links.app(d.team, d.app)} variant="body-small">
                  {d.team}/{d.app}
                </Link>
              </span>
            )}
            <span>
              Stage <Mono>{d.stage}</Mono> · tier <Mono>{d.tier}</Mono>
            </span>
            {by?.user_login && (
              <span className="daas-inline">
                <RiUserLine size={14} aria-hidden /> {by.user_login}
              </span>
            )}
            {by?.sha && (
              <span className="daas-inline">
                <RiGitCommitLine size={14} aria-hidden />
                <Mono>{by.sha.slice(0, 8)}</Mono>
                {by.ref && (
                  <Text variant="body-x-small" color="secondary">
                    on {by.ref}
                  </Text>
                )}
              </span>
            )}
            {by?.pipeline_id && by.project_path && links.gitlabProject(by.project_path) && (
              <Link
                href={`${links.gitlabProject(by.project_path)}/-/pipelines/${by.pipeline_id}`}
                variant="body-small"
                target="_blank"
              >
                Pipeline #{by.pipeline_id}
              </Link>
            )}
            {d.expiresAt && <span>Expires {new Date(d.expiresAt).toLocaleString()}</span>}
          </div>
          {d.message && (
            <Text as="p" variant="body-small" color={d.status === 'failed' ? 'danger' : 'secondary'}>
              {d.message}
            </Text>
          )}
          <ol className="daas-waves">
            {waves.map(w => (
              <li key={w} className="daas-wave">
                <span className="daas-wave__label">Wave {w}</span>
                <div className="daas-wave__targets">
                  {d.clusters
                    .filter(c => c.wave === w)
                    .map(c => {
                      const info = clusters.get(c.cluster);
                      return (
                        <div key={c.cluster} className="daas-target">
                          {info && <CloudBadge provider={info.provider} region={info.region} />}
                          <Mono>{c.cluster}</Mono>
                          <StatusBadge status={c.status} />
                          {c.revision && <Mono>{c.revision.slice(0, 8)}</Mono>}
                          {c.detail && (
                            <Text variant="body-x-small" color="secondary">
                              {c.detail}
                            </Text>
                          )}
                        </div>
                      );
                    })}
                </div>
              </li>
            ))}
          </ol>
          {!!d.skippedTargets?.length && (
            <Text variant="body-x-small" color="secondary">
              Skipped (no cluster for this stage): {d.skippedTargets.join(', ')}
            </Text>
          )}
        </div>
      )}
    </li>
  );
}
