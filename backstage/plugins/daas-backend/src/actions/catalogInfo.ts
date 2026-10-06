import { parseAllDocuments, stringify } from 'yaml';

/** Links a catalog entity to its DAAS app (the entity's "Deployments" tab reads it). */
export const DAAS_APP_ANNOTATION = 'daas.io/app';

/**
 * Make sure the repo's catalog-info.yaml carries `daas.io/app: <team>/<app>`.
 *
 * - No file: create a Component owned by the team's Group.
 * - A file: set the annotation on its first Component (or, failing that, its first entity), keeping
 *   comments and every other document as they are.
 *
 * Returns the new file, or undefined when nothing needs to change.
 */
export function upsertCatalogInfo(
  existing: string | undefined,
  app: { name: string; team: string; project: string; kind?: string },
): string | undefined {
  const value = `${app.team}/${app.name}`;
  if (!existing?.trim()) {
    return `${stringify(
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name: app.name,
          annotations: { [DAAS_APP_ANNOTATION]: value, 'gitlab.com/project-slug': app.project },
        },
        spec: {
          type: app.kind === 'service' || !app.kind ? 'service' : app.kind,
          lifecycle: 'production',
          owner: `group:default/${app.team}`,
        },
      },
      { lineWidth: 0 },
    )}`;
  }
  const docs = parseAllDocuments(existing);
  if (!Array.isArray(docs) || !docs.length) throw new Error('catalog-info.yaml could not be parsed');
  for (const d of docs)
    if (d.errors.length) throw new Error(`catalog-info.yaml is not valid YAML: ${d.errors[0].message}`);
  const target = docs.find(d => d.get('kind') === 'Component') ?? docs.find(d => d.get('metadata'));
  if (!target) throw new Error('catalog-info.yaml has no entity to annotate');
  if (target.getIn(['metadata', 'annotations', DAAS_APP_ANNOTATION]) === value) return undefined;
  target.setIn(['metadata', 'annotations', DAAS_APP_ANNOTATION], value);
  return docs.map(d => d.toString({ lineWidth: 0 })).join('');
}
