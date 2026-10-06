import { ButtonLink, Card, CardBody, Link, SearchField, Text } from '@backstage/ui';
import { RiLockLine, RiShieldCheckLine, RiUserLine } from '@remixicon/react';
import type { AppView, PlatformView, TeamView } from '@internal/plugin-daas-common';
import { ReactNode, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { latestByEnvironment, stageIndex, teamByName } from '../data';
import { timeAgo } from '../format';
import { useDaas } from '../hooks';
import { useLinks } from '../routes';
import { useScope } from '../scope';
import {
  CloudBadge,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Mono,
  Section,
  StagePill,
  StatusBadge,
} from './ui';

export function TeamCard({
  team,
  platform,
  apps,
  compact,
}: {
  team: TeamView;
  platform: PlatformView;
  apps?: AppView[];
  compact?: boolean;
}) {
  const links = useLinks();
  const order = stageIndex(platform);
  const stages = Object.keys(team.stages).sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
  const clouds = [...new Set(team.clusters.map(c => c.provider))];
  const appCount = apps?.filter(a => a.team === team.name).length;
  return (
    <Card href={links.team(team.name)} label={`Team ${team.name}`} className="daas-card">
      <CardBody>
        <div className="daas-card__row">
          <Text variant="body-large" weight="bold">
            {team.name}
          </Text>
          <Text variant="body-small" color="secondary">
            {appCount === undefined ? '' : `${appCount} app${appCount === 1 ? '' : 's'}`}
          </Text>
        </div>
        {!compact && (
          <Text variant="body-small" color="secondary">
            Namespace <Mono>{team.namespace}</Mono>
          </Text>
        )}
        <div className="daas-card__row daas-card__row--wrap">
          {stages.map(s => (
            <StagePill key={s} name={s} />
          ))}
        </div>
        <div className="daas-card__row daas-card__row--wrap">
          {clouds.map(p => (
            <CloudBadge key={p} provider={p} />
          ))}
          <Text variant="body-x-small" color="secondary">
            {team.clusters.length} cluster{team.clusters.length === 1 ? '' : 's'}
          </Text>
        </div>
      </CardBody>
    </Card>
  );
}

export function TeamsPage() {
  const links = useLinks();
  const platform = useDaas(api => api.platform(), []);
  const apps = useDaas(api => api.apps(), []);
  const [q, setQ] = useState('');
  const { inScope } = useScope();
  if (platform.error) return <ErrorState error={platform.error} onRetry={platform.reload} />;
  if (!platform.value) return <LoadingBlock rows={6} />;
  const teams = platform.value.teams.filter(
    t =>
      inScope(t.name) &&
      (!q || t.name.includes(q.toLowerCase()) || t.owners.some(o => o.toLowerCase().includes(q.toLowerCase()))),
  );
  const onboard = links.onboardTeam();
  return (
    <div className="daas-stack">
      <div className="daas-toolbar">
        <SearchField
          aria-label="Search teams"
          placeholder="Search teams or owners"
          value={q}
          onChange={setQ}
          size="small"
        />
        <Text variant="body-small" color="secondary">
          Each team is a folder in the platform repository: access.yaml, clusters.yaml and secrets.yaml.
        </Text>
      </div>
      {teams.length ? (
        <div className="daas-grid">
          {teams.map(t => (
            <TeamCard key={t.name} team={t} platform={platform.value!} apps={apps.value} />
          ))}
        </div>
      ) : (
        <EmptyState
          title={q ? 'No team matches' : 'No teams yet'}
          action={
            onboard && (
              <ButtonLink href={onboard} variant="primary" size="small">
                Onboard a team
              </ButtonLink>
            )
          }
        >
          {q ? 'Try a different name.' : 'Onboarding opens a merge request against the platform repository.'}
        </EmptyState>
      )}
    </div>
  );
}

export function TeamPage() {
  const { team: name = '' } = useParams();
  return <TeamDetail name={name} />;
}

/** Everything about one team. Also the "Deployments" tab on the team's Group entity. */
export function TeamDetail({ name, embedded, notFound }: { name: string; embedded?: boolean; notFound?: ReactNode }) {
  const links = useLinks();
  const platform = useDaas(api => api.platform(), []);
  const apps = useDaas(api => api.apps(name), [name]);
  const deployments = useDaas(api => api.deployments({ team: name, limit: 200 }), [name]);
  const latest = useMemo(() => latestByEnvironment(deployments.value), [deployments.value]);

  if (platform.error) return <ErrorState error={platform.error} onRetry={platform.reload} />;
  if (!platform.value) return <LoadingBlock rows={6} />;
  const team = teamByName(platform.value, name);
  if (!team) {
    return (
      <>
        {notFound ?? <EmptyState title={`No team called “${name}”`}>It isn’t in the platform repository.</EmptyState>}
      </>
    );
  }
  const order = stageIndex(platform.value);
  const stages = platform.value.stages.filter(s => team.stages[s.name]);
  const createApp = links.createApp(team.name);

  return (
    <div className="daas-stack">
      <div className="daas-titlebar">
        <div>
          {!embedded && (
            <Text as="h1" variant="title-medium" weight="bold">
              {team.name}
            </Text>
          )}
          <div className="daas-meta">
            <span>
              Namespace <Mono>{team.namespace}</Mono>
            </span>
            {team.group && (
              <span>
                GitLab group <Mono>{team.group}</Mono>
              </span>
            )}
            <span>
              Pod security <Mono>{team.podSecurity}</Mono>
            </span>
            <span>
              Secrets in{' '}
              <strong>{team.secretsProvider === 'gcp' ? 'GCP Secret Manager' : 'AWS Secrets Manager'}</strong>
            </span>
          </div>
        </div>
        {createApp && (
          <ButtonLink href={createApp} variant="primary" size="small">
            New app for {team.name}
          </ButtonLink>
        )}
      </div>

      <Section
        title="Where it runs"
        description="Stages the team can deploy to, their gates, and the team’s dedicated clusters."
      >
        <div className="daas-matrix">
          {stages.map(s => {
            const gates = team.stages[s.name] ?? {};
            const clusters = team.clusters.filter(c => c.stage === s.name);
            return (
              <div key={s.name} className="daas-matrix__row">
                <div className="daas-matrix__stage">
                  <StagePill name={s.name} tier={s.gitlabTier} preview={s.preview} />
                  <div className="daas-gates">
                    {gates.protectedRefOnly && (
                      <span className="daas-gate">
                        <RiLockLine size={12} aria-hidden /> Protected refs only
                      </span>
                    )}
                    {gates.requireProtectedEnvironment && (
                      <span className="daas-gate">
                        <RiShieldCheckLine size={12} aria-hidden /> Protected environment
                      </span>
                    )}
                    {!gates.protectedRefOnly && !gates.requireProtectedEnvironment && (
                      <Text variant="body-x-small" color="secondary">
                        No extra gates
                      </Text>
                    )}
                  </div>
                </div>
                <div className="daas-matrix__clusters">
                  {clusters.length ? (
                    clusters.map(c => (
                      <div key={c.name} className="daas-cluster">
                        <CloudBadge provider={c.provider} region={c.region} />
                        <Mono>{c.name}</Mono>
                        {c.domain && (
                          <Text variant="body-x-small" color="secondary">
                            *.{c.domain}
                          </Text>
                        )}
                        {s.preview && c.previewDomain && (
                          <Text variant="body-x-small" color="secondary">
                            previews *.{c.previewDomain}
                          </Text>
                        )}
                      </div>
                    ))
                  ) : (
                    <Text variant="body-small" color="secondary">
                      No cluster for this stage yet. Deployments here will fail until one is added to clusters.yaml.
                    </Text>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <div className="daas-split">
        <Section
          title="Apps"
          actions={
            <Link href={links.apps(team.name)} variant="body-small">
              Open in Apps
            </Link>
          }
        >
          {apps.error ? (
            <ErrorState error={apps.error} onRetry={apps.reload} />
          ) : !apps.value ? (
            <LoadingBlock />
          ) : (
            <DataTable
              rows={apps.value}
              rowKey={a => a.app}
              empty={<EmptyState title="No apps yet">Apps show up after their first deployment.</EmptyState>}
              columns={[
                {
                  key: 'app',
                  label: 'App',
                  render: a => (
                    <Link href={links.app(a.team, a.app)} weight="bold">
                      {a.app}
                    </Link>
                  ),
                },
                {
                  key: 'envs',
                  label: 'Environments',
                  wrap: true,
                  render: a => (
                    <div className="daas-inline">
                      {[...a.environments]
                        .sort((x, y) => (order.get(x.stage) ?? 0) - (order.get(y.stage) ?? 0))
                        .map(e => {
                          const d = latest.get(`${a.team}/${a.app}/${e.environment}`);
                          return (
                            <span key={e.environment} className="daas-inline" title={e.environment}>
                              <Mono>{e.environment}</Mono>
                              {d && <StatusBadge status={d.status} />}
                            </span>
                          );
                        })}
                    </div>
                  ),
                },
              ]}
            />
          )}
        </Section>

        <Section title="Access">
          <dl className="daas-dl">
            <dt>Owners</dt>
            <dd>
              {team.owners.length
                ? team.owners.map(o => (
                    <span key={o} className="daas-inline">
                      <RiUserLine size={14} aria-hidden /> {o}
                    </span>
                  ))
                : '—'}
            </dd>
            <dt>Projects that may deploy</dt>
            <dd>
              {team.projects.map(p => (
                <Mono key={p}>{p}</Mono>
              ))}
            </dd>
            <dt>Secret writers (Entra)</dt>
            <dd>
              {Object.keys(team.secretWriters).length
                ? Object.entries(team.secretWriters).map(([stage, group]) => (
                    <span key={stage} className="daas-inline">
                      <StagePill name={stage} /> <Mono>{group}</Mono>
                    </span>
                  ))
                : 'Platform admins only'}
            </dd>
            {team.domains.length > 0 && (
              <>
                <dt>Custom domains</dt>
                <dd>
                  {team.domains.map(d => (
                    <Mono key={d}>{d}</Mono>
                  ))}
                </dd>
              </>
            )}
            <dt>Preview environments</dt>
            <dd>
              {team.preview.maxConcurrent ?? 'Unlimited'} at once
              {team.preview.quota?.cpu || team.preview.quota?.memory
                ? ` · quota ${[team.preview.quota.cpu && `${team.preview.quota.cpu} CPU`, team.preview.quota.memory]
                    .filter(Boolean)
                    .join(', ')}`
                : ''}
            </dd>
            <dt>Last deployment</dt>
            <dd>{deployments.value?.[0] ? timeAgo(deployments.value[0].createdAt) : '—'}</dd>
          </dl>
        </Section>
      </div>
    </div>
  );
}
