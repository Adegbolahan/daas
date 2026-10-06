import type { Entity } from '@backstage/catalog-model';
import { apps, platform } from './fixtures';

const group = (name: string, title: string): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Group',
  metadata: { name, title, namespace: 'default', annotations: { 'daas.io/team': name } },
  spec: { type: 'team', children: [], members: name === 'payments' || name === 'identity' ? ['dev'] : [] },
});

/** Catalog entities for the harness: the DAAS teams as Groups, the dev user, and one Component per app. */
export const catalogEntities: Entity[] = [
  ...platform.teams.map(t => group(t.name, `${t.name[0].toUpperCase()}${t.name.slice(1)} team`)),
  group('platform', 'Platform team'),
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'User',
    metadata: { name: 'dev', namespace: 'default' },
    spec: { profile: { displayName: 'Dev User', email: 'dev@example.com' }, memberOf: ['payments', 'identity'] },
  },
  ...apps.map((a): Entity => ({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: a.app,
      namespace: 'default',
      annotations: { 'daas.io/app': `${a.team}/${a.app}`, 'gitlab.com/project-slug': a.project },
    },
    spec: { type: a.kind ?? 'service', lifecycle: 'production', owner: `group:default/${a.team}` },
  })),
];

/** Who the harness signs you in as: a member of payments and identity. */
export const devIdentity = {
  userEntityRef: 'user:default/dev',
  ownershipEntityRefs: ['user:default/dev', 'group:default/payments', 'group:default/identity'],
};
