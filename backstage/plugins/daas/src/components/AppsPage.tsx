import { Link, SearchField, Select, Text } from '@backstage/ui';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { latestByEnvironment, stageIndex } from '../data';
import { timeAgo } from '../format';
import { useDaas } from '../hooks';
import { useLinks } from '../routes';
import { useScope } from '../scope';
import { DataTable, EmptyState, ErrorState, LoadingBlock, Mono, StagePill, StatusBadge } from './ui';

const ALL = '__all__';

export function AppsPage() {
  const links = useLinks();
  const [params, setParams] = useSearchParams();
  const team = params.get('team') ?? '';
  const [q, setQ] = useState('');
  const platform = useDaas(api => api.platform(), []);
  const apps = useDaas(api => api.apps(team || undefined), [team]);
  const deployments = useDaas(api => api.deployments({ team: team || undefined, limit: 500 }), [team]);
  const latest = useMemo(() => latestByEnvironment(deployments.value), [deployments.value]);
  const order = stageIndex(platform.value);

  const { inScope } = useScope();
  // An explicit team filter wins over the my-teams scope.
  const rows = (apps.value ?? []).filter(
    a => (team || inScope(a.team)) && (!q || a.app.includes(q.toLowerCase()) || a.project.includes(q)),
  );

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
          onChange={key => {
            const next = new URLSearchParams(params);
            if (!key || key === ALL) next.delete('team');
            else next.set('team', String(key));
            setParams(next, { replace: true });
          }}
        />
        <SearchField
          aria-label="Search apps"
          placeholder="Search apps or projects"
          value={q}
          onChange={setQ}
          size="small"
        />
      </div>
      {apps.error ? (
        <ErrorState error={apps.error} onRetry={apps.reload} />
      ) : !apps.value ? (
        <LoadingBlock rows={6} />
      ) : (
        <DataTable
          rows={rows}
          rowKey={a => `${a.team}/${a.app}`}
          empty={
            <EmptyState title={q || team ? 'No app matches' : 'No apps yet'}>
              Apps appear after their first deployment. Start one with “New app”.
            </EmptyState>
          }
          columns={[
            {
              key: 'app',
              label: 'App',
              render: a => (
                <div className="daas-cellstack">
                  <Link href={links.app(a.team, a.app)} weight="bold">
                    {a.app}
                  </Link>
                  <Text variant="body-x-small" color="secondary">
                    {a.project}
                  </Text>
                </div>
              ),
            },
            {
              key: 'team',
              label: 'Team',
              render: a => (
                <Link href={links.team(a.team)} variant="body-small">
                  {a.team}
                </Link>
              ),
            },
            { key: 'kind', label: 'Kind', render: a => <Text variant="body-small">{a.kind ?? 'service'}</Text> },
            {
              key: 'stages',
              label: 'Running in',
              wrap: true,
              render: a => {
                const stages = [...new Set(a.environments.map(e => e.stage))].sort(
                  (x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0),
                );
                const previews = a.environments.filter(e => e.preview).length;
                return (
                  <div className="daas-inline">
                    {stages.map(s => (
                      <StagePill key={s} name={s} />
                    ))}
                    {previews > 0 && (
                      <Text variant="body-x-small" color="secondary">
                        {previews} preview{previews === 1 ? '' : 's'}
                      </Text>
                    )}
                  </div>
                );
              },
            },
            {
              key: 'last',
              label: 'Last deployment',
              render: a => {
                const d = a.environments
                  .map(e => latest.get(`${a.team}/${a.app}/${e.environment}`))
                  .filter(Boolean)
                  .sort((x, y) => y!.createdAt.localeCompare(x!.createdAt))[0];
                return d ? (
                  <div className="daas-inline">
                    <StatusBadge status={d.status} />
                    <Mono>{d.environment}</Mono>
                    <Text variant="body-x-small" color="secondary">
                      {timeAgo(d.createdAt)}
                    </Text>
                  </div>
                ) : (
                  <Text variant="body-small" color="secondary">
                    —
                  </Text>
                );
              },
            },
          ]}
        />
      )}
    </div>
  );
}
