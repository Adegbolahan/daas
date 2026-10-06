/** Shapes returned by the DAAS API (see api/daas_api/main.py) and relayed by the DAAS backend plugin. */

export type Cloud = 'gke' | 'eks';

export interface StageView {
  name: string;
  gitlabTier: 'production' | 'staging' | 'testing' | 'development' | 'other';
  environments: string[];
  preview: boolean;
  partialTargets: boolean;
  allowStop: boolean;
  autoApply: boolean;
  secrets?: { gcpProject: string; awsAccount: string; awsRegion: string };
}

export interface ClusterView {
  name: string;
  stage: string;
  provider: Cloud;
  region: string;
  domain?: string | null;
  previewDomain?: string | null;
  hasGateway: boolean;
  features: string[];
}

export interface StageGates {
  protectedRefOnly?: boolean;
  requireProtectedEnvironment?: boolean;
}

export interface TeamView {
  name: string;
  namespace: string;
  group: string | null;
  owners: string[];
  projects: string[];
  stages: Record<string, StageGates>;
  domains: string[];
  podSecurity: 'restricted' | 'baseline';
  secretsProvider: 'gcp' | 'aws';
  secretWriters: Record<string, string>;
  preview: { maxConcurrent?: number; quota?: { cpu?: string; memory?: string } };
  clusters: ClusterView[];
}

export interface PlatformView {
  stages: StageView[];
  teams: TeamView[];
  registry: { server?: string } | null;
  conventions: { secretKeySeparator: string; previewNamespaceSuffix: string; platformSecretsApp: string };
  configError?: string | null;
}

export interface AppEnvironment {
  environment: string;
  stage: string;
  tier: string;
  name: string;
  namespace: string;
  preview: boolean;
  expiresAt?: string | null;
  image?: string | null;
  deploymentId?: string | null;
  clusters: { cluster: string; hosts: string[] }[];
}

export interface AppView {
  team: string;
  app: string;
  project: string;
  kind?: 'service' | 'worker' | 'cronjob';
  environments: AppEnvironment[];
}

export type DeploymentStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface DeploymentRecord {
  id: string;
  createdAt: string;
  updatedAt?: string;
  status: DeploymentStatus;
  message?: string;
  app: string;
  kind?: string;
  name: string;
  namespace: string;
  team: string;
  environment: string;
  stage: string;
  tier: string;
  image: string;
  dryRun?: boolean;
  requestedBy?: { project_path?: string; ref?: string; sha?: string; user_login?: string; pipeline_id?: string };
  clusters: { cluster: string; wave: number; status: string; revision?: string; detail?: string }[];
  skippedTargets?: string[];
  expiresAt?: string;
}

export interface PreviewResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  skippedTargets: string[];
  missingSecrets: { name: string; provider: 'gcp' | 'aws' }[];
  plan: { cluster: string; provider: Cloud; region: string; wave: number; hosts: string[] }[];
  manifests: Record<string, string>;
  kind?: string;
  name?: string;
  namespace?: string;
  stage?: string;
}

export interface SecretListItem {
  name: string;
  provider: 'gcp' | 'aws';
  key: string;
  updated: string | null;
}

/** JSON Schema documents, as served by GET /v1/schemas. */
export interface DaasSchemas {
  app: JsonSchema;
  teamAccess: JsonSchema;
  teamClusters: JsonSchema;
  teamSecrets: JsonSchema;
}

// A deliberately loose JSON Schema type: we only read the parts we transform.
export type JsonSchema = {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  uniqueItems?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
  [key: string]: unknown;
};
