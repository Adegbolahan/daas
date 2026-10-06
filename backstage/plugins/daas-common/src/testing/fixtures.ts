import type { DaasSchemas, PlatformView } from '../types';
import appSchema from '../../../../../spec/daas.schema.json';
import teamAccess from '../../../../../spec/team-access.schema.json';
import teamClusters from '../../../../../spec/team-clusters.schema.json';
import teamSecrets from '../../../../../spec/team-secrets.schema.json';

/** The real DAAS schemas from spec/, so tests break when the API's contract moves. */
export const schemas = { app: appSchema, teamAccess, teamClusters, teamSecrets } as unknown as DaasSchemas;

export const platform: PlatformView = {
  stages: [
    {
      name: 'review',
      gitlabTier: 'development',
      environments: ['review/*'],
      preview: true,
      partialTargets: true,
      allowStop: true,
      autoApply: true,
    },
    {
      name: 'dev',
      gitlabTier: 'development',
      environments: ['dev', 'qa-*'],
      preview: false,
      partialTargets: true,
      allowStop: true,
      autoApply: true,
    },
    {
      name: 'staging',
      gitlabTier: 'staging',
      environments: ['staging'],
      preview: false,
      partialTargets: false,
      allowStop: false,
      autoApply: true,
    },
    {
      name: 'production',
      gitlabTier: 'production',
      environments: ['production'],
      preview: false,
      partialTargets: false,
      allowStop: false,
      autoApply: false,
    },
  ],
  teams: [
    {
      name: 'payments',
      namespace: 'payments',
      group: 'acme/payments',
      owners: ['ada@acme.io'],
      projects: ['acme/payments/*'],
      stages: { review: {}, staging: { protectedRefOnly: true }, production: { protectedRefOnly: true } },
      domains: [],
      podSecurity: 'restricted',
      secretsProvider: 'gcp',
      secretWriters: {},
      preview: {},
      clusters: [
        {
          name: 'payments-prod-euw1',
          stage: 'production',
          provider: 'gke',
          region: 'europe-west1',
          domain: 'pay.acme.io',
          hasGateway: true,
          features: [],
        },
        {
          name: 'payments-prod-use1',
          stage: 'production',
          provider: 'eks',
          region: 'us-east-1',
          domain: 'us.pay.acme.io',
          hasGateway: true,
          features: [],
        },
      ],
    },
  ],
  registry: null,
  conventions: { secretKeySeparator: '_', previewNamespaceSuffix: '-preview', platformSecretsApp: 'daas' },
};
