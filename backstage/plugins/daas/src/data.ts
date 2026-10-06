import type { AppView, ClusterView, DeploymentRecord, PlatformView, TeamView } from '@internal/plugin-daas-common';

/** Stage order as declared in stages.yaml (the promotion path). */
export function stageIndex(platform?: PlatformView): Map<string, number> {
  return new Map((platform?.stages ?? []).map((s, i) => [s.name, i]));
}

export function teamByName(platform: PlatformView | undefined, name?: string): TeamView | undefined {
  return platform?.teams.find(t => t.name === name);
}

export function allClusters(platform?: PlatformView): (ClusterView & { team: string })[] {
  return (platform?.teams ?? []).flatMap(t => t.clusters.map(c => ({ ...c, team: t.name })));
}

export function clusterLookup(platform?: PlatformView): Map<string, ClusterView> {
  return new Map(allClusters(platform).map(c => [c.name, c]));
}

/** Newest deployment per team/app/environment (records arrive newest first). */
export function latestByEnvironment(deployments: DeploymentRecord[] = []): Map<string, DeploymentRecord> {
  const out = new Map<string, DeploymentRecord>();
  for (const d of deployments) {
    const key = `${d.team}/${d.app}/${d.environment}`;
    if (!out.has(key)) out.set(key, d);
  }
  return out;
}

export function latestForApp(deployments: DeploymentRecord[] = [], app: AppView): DeploymentRecord | undefined {
  return deployments.find(d => d.team === app.team && d.app === app.app);
}

export function isActive(d: DeploymentRecord): boolean {
  return d.status === 'pending' || d.status === 'running';
}

/** Distinct provider/region pairs a team can target (what `targets:` accepts). */
export function targetOptions(
  team?: TeamView,
  stage?: string,
): { provider: 'gke' | 'eks'; region: string; clusters: ClusterView[] }[] {
  const byKey = new Map<string, { provider: 'gke' | 'eks'; region: string; clusters: ClusterView[] }>();
  for (const c of (team?.clusters ?? []).filter(x => !stage || x.stage === stage)) {
    const key = `${c.provider}/${c.region}`;
    const hit = byKey.get(key) ?? { provider: c.provider, region: c.region, clusters: [] };
    hit.clusters.push(c);
    byKey.set(key, hit);
  }
  return [...byKey.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.region.localeCompare(b.region));
}
