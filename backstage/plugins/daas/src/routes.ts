import { createRouteRef, useRouteRef } from '@backstage/frontend-plugin-api';
import { useMemo } from 'react';
import { useDaas } from './hooks';
import { repoUrlFor, templatePath } from './format';

export const rootRouteRef = createRouteRef();

/** Absolute links inside the DAAS page, plus links out to the scaffolder. */
export function useLinks() {
  const root = useRouteRef(rootRouteRef);
  const base = (root?.() ?? '/daas').replace(/\/$/, '');
  const ui = useDaas(api => api.uiConfig(), []);
  return useMemo(() => {
    const cfg = ui.value;
    const tpl = (ref: string | undefined, formData?: Record<string, unknown>) => {
      if (!cfg || !ref) return undefined;
      const path = templatePath(cfg.scaffolderPath, ref);
      return formData ? `${path}?formData=${encodeURIComponent(JSON.stringify(formData))}` : path;
    };
    return {
      base,
      overview: base,
      teams: `${base}/teams`,
      team: (team: string) => `${base}/teams/${encodeURIComponent(team)}`,
      apps: (team?: string) => `${base}/apps${team ? `?team=${encodeURIComponent(team)}` : ''}`,
      app: (team: string, app: string) => `${base}/apps/${encodeURIComponent(team)}/${encodeURIComponent(app)}`,
      deployments: (q: Record<string, string | undefined> = {}) => {
        const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
        return `${base}/deployments${s ? `?${s}` : ''}`;
      },
      secrets: (q: Record<string, string | undefined> = {}) => {
        const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
        return `${base}/secrets${s ? `?${s}` : ''}`;
      },
      createApp: (team?: string) => tpl(cfg?.templates.create, team ? { team } : undefined),
      updateApp: (formData: Record<string, unknown>) => tpl(cfg?.templates.update, formData),
      onboardTeam: () => tpl(cfg?.templates.onboard),
      gitlabProject: (project?: string) => (cfg && project ? `https://${cfg.gitlabHost}/${project}` : undefined),
      repoUrl: (project?: string) => (cfg ? repoUrlFor(cfg.gitlabHost, project) : undefined),
    };
  }, [base, ui.value]);
}

export type Links = ReturnType<typeof useLinks>;
