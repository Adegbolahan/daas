import type { Entity } from '@backstage/catalog-model';

/** `daas.io/app: <team>/<app>` links a catalog entity to its DAAS app. */
export const DAAS_APP_ANNOTATION = 'daas.io/app';

export function parseAppAnnotation(entity: Entity): { team: string; app: string } | undefined {
  const value = entity.metadata.annotations?.[DAAS_APP_ANNOTATION];
  const m = value?.match(/^([a-z0-9-]+)\/([a-z0-9-]+)$/);
  return m ? { team: m[1], app: m[2] } : undefined;
}

export const isDaasApp = (entity: Entity) => !!parseAppAnnotation(entity);

/** `daas.io/team: <team>` on a Group names its DAAS team; without it the Group's own name is used. */
export const DAAS_TEAM_ANNOTATION = 'daas.io/team';

export function teamNameFor(entity: Entity): string {
  return entity.metadata.annotations?.[DAAS_TEAM_ANNOTATION] ?? entity.metadata.name;
}

export const isGroup = (entity: Entity) => entity.kind.toLowerCase() === 'group';
