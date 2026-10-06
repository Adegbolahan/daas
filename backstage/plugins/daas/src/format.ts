import type { DeploymentStatus } from '@internal/plugin-daas-common';

export function timeAgo(iso?: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : new Date(iso).toLocaleDateString();
}

export function shortImage(image?: string | null): string {
  if (!image) return '—';
  const at = image.lastIndexOf('@');
  if (at > 0) return `${image.slice(image.lastIndexOf('/', at) + 1, at)}@${image.slice(at + 8, at + 20)}`;
  return image.slice(image.lastIndexOf('/') + 1);
}

export const STATUS_LABEL: Record<DeploymentStatus | 'committed' | 'healthy' | 'unhealthy' | 'syncing', string> = {
  pending: 'Pending',
  running: 'Rolling out',
  succeeded: 'Succeeded',
  failed: 'Failed',
  committed: 'Committed',
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
  syncing: 'Syncing',
};

export type Tone = 'success' | 'danger' | 'warning' | 'info' | 'neutral';

export function statusTone(status?: string): Tone {
  switch (status) {
    case 'succeeded':
    case 'healthy':
      return 'success';
    case 'failed':
    case 'unhealthy':
      return 'danger';
    case 'running':
    case 'syncing':
    case 'pending':
      return 'info';
    case 'committed':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** Scaffolder repoUrl for a GitLab project path. */
export function repoUrlFor(host: string, projectPath?: string): string | undefined {
  if (!projectPath) return undefined;
  const i = projectPath.lastIndexOf('/');
  return `${host}?owner=${encodeURIComponent(projectPath.slice(0, i))}&repo=${encodeURIComponent(projectPath.slice(i + 1))}`;
}

export function templatePath(scaffolderPath: string, templateRef: string): string {
  const [, rest] = templateRef.split(':');
  const [namespace, name] = rest.split('/');
  return `${scaffolderPath}/templates/${namespace}/${name}`;
}
