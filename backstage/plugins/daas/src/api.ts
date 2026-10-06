import { createApiRef, DiscoveryApi, FetchApi, OAuthApi } from '@backstage/frontend-plugin-api';
import type {
  AppView,
  DaasSchemas,
  DeploymentRecord,
  PlatformView,
  PreviewResult,
  SecretListItem,
} from '@internal/plugin-daas-common';

const enc = encodeURIComponent;

export interface UiConfig {
  gitlabHost: string;
  scaffolderPath: string;
  templates: { create: string; update: string; onboard: string };
  secretsScope: string;
}

export interface DaasApi {
  uiConfig(): Promise<UiConfig>;
  platform(): Promise<PlatformView>;
  schemas(): Promise<DaasSchemas>;
  apps(team?: string): Promise<AppView[]>;
  deployments(filter?: {
    team?: string;
    app?: string;
    environment?: string;
    limit?: number;
  }): Promise<DeploymentRecord[]>;
  appSpec(
    team: string,
    app: string,
    environment?: string,
  ): Promise<{ spec: string; environment: string; project?: string }>;
  preview(body: { spec: string; team: string; environment: string }): Promise<PreviewResult>;
  listSecrets(stage: string, team: string, app: string): Promise<SecretListItem[]>;
  putSecret(
    stage: string,
    team: string,
    app: string,
    name: string,
    value: string,
    provider?: 'gcp' | 'aws',
  ): Promise<{ key: string; provider: string }>;
  deleteSecret(stage: string, team: string, app: string, name: string, provider?: 'gcp' | 'aws'): Promise<void>;
}

export const daasApiRef = createApiRef<DaasApi>({ id: 'plugin.daas.api' });

export class DaasError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'DaasError';
  }
}

/**
 * Talks to the DAAS backend plugin (/api/daas). Secret calls also carry the signed-in user's own
 * Entra token, so DAAS can check the user's role for that team and stage.
 */
export class DaasClient implements DaasApi {
  private ui?: Promise<UiConfig>;

  constructor(private readonly deps: { discoveryApi: DiscoveryApi; fetchApi: FetchApi; microsoftAuthApi?: OAuthApi }) {}

  private async request<T>(path: string, init: RequestInit & { userToken?: boolean } = {}): Promise<T> {
    const base = await this.deps.discoveryApi.getBaseUrl('daas');
    const headers = new Headers(init.headers);
    if (init.body) headers.set('content-type', 'application/json');
    if (init.userToken) headers.set('x-daas-user-token', await this.userToken());
    const res = await this.deps.fetchApi.fetch(`${base}${path}`, { ...init, headers });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      let detail: unknown;
      try {
        const body = await res.json();
        detail = body?.detail;
        message = body?.error?.message ?? message;
      } catch {
        /* not JSON */
      }
      throw new DaasError(res.status, message, detail);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  private async userToken(): Promise<string> {
    const auth = this.deps.microsoftAuthApi;
    const { secretsScope } = await this.uiConfig();
    // No scope configured: DAAS runs without Entra (dev mode) and doesn't need a user token.
    if (!auth || !secretsScope) return 'none';
    return auth.getAccessToken(secretsScope);
  }

  uiConfig() {
    this.ui ??= this.request<UiConfig>('/ui-config');
    return this.ui;
  }
  platform() {
    return this.request<PlatformView>('/platform');
  }
  schemas() {
    return this.request<DaasSchemas>('/schemas');
  }
  async apps(team?: string) {
    const q = team ? `?team=${encodeURIComponent(team)}` : '';
    return (await this.request<{ apps: AppView[] }>(`/apps${q}`)).apps;
  }
  async deployments(filter: { team?: string; app?: string; environment?: string; limit?: number } = {}) {
    const q = new URLSearchParams(
      Object.entries(filter)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => [k, String(v)]),
    );
    return (await this.request<{ deployments: DeploymentRecord[] }>(`/deployments?${q}`)).deployments;
  }
  appSpec(team: string, app: string, environment?: string) {
    const q = environment ? `?environment=${encodeURIComponent(environment)}` : '';
    return this.request<{ spec: string; environment: string; project?: string }>(
      `/apps/${encodeURIComponent(team)}/${encodeURIComponent(app)}/spec${q}`,
    );
  }
  preview(body: { spec: string; team: string; environment: string }) {
    return this.request<PreviewResult>('/preview', { method: 'POST', body: JSON.stringify(body) });
  }
  async listSecrets(stage: string, team: string, app: string) {
    return (
      await this.request<{ secrets: SecretListItem[] }>(`/secrets/${enc(stage)}/${enc(team)}/${enc(app)}`, {
        userToken: true,
      })
    ).secrets;
  }
  putSecret(stage: string, team: string, app: string, name: string, value: string, provider?: 'gcp' | 'aws') {
    return this.request<{ key: string; provider: string }>(
      `/secrets/${enc(stage)}/${enc(team)}/${enc(app)}/${enc(name)}`,
      { method: 'PUT', body: JSON.stringify({ value, provider }), userToken: true },
    );
  }
  async deleteSecret(stage: string, team: string, app: string, name: string, provider?: 'gcp' | 'aws') {
    const q = provider ? `?provider=${provider}` : '';
    await this.request(`/secrets/${enc(stage)}/${enc(team)}/${enc(app)}/${enc(name)}${q}`, {
      method: 'DELETE',
      userToken: true,
    });
  }
}
