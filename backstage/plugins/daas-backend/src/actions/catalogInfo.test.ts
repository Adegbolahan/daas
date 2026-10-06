import { parse, parseAllDocuments } from 'yaml';
import { upsertCatalogInfo } from './catalogInfo';

const app = { name: 'checkout-api', team: 'payments', project: 'acme/payments/checkout-api', kind: 'service' };

describe('upsertCatalogInfo', () => {
  it('creates a Component owned by the team when the repo has none', () => {
    const doc = parse(upsertCatalogInfo(undefined, app)!);
    expect(doc).toMatchObject({
      kind: 'Component',
      metadata: {
        name: 'checkout-api',
        annotations: {
          'daas.io/app': 'payments/checkout-api',
          'gitlab.com/project-slug': 'acme/payments/checkout-api',
        },
      },
      spec: { owner: 'group:default/payments', lifecycle: 'production', type: 'service' },
    });
  });

  it('annotates the Component in an existing multi-document file and keeps the rest', () => {
    const existing = [
      '# owned by payments',
      'apiVersion: backstage.io/v1alpha1',
      'kind: System',
      'metadata: { name: payments }',
      '---',
      'apiVersion: backstage.io/v1alpha1',
      'kind: Component',
      'metadata:',
      '  name: checkout',
      '  annotations:',
      '    backstage.io/techdocs-ref: dir:.',
      'spec: { type: service, owner: team-payments, lifecycle: production }',
      '',
    ].join('\n');
    const out = upsertCatalogInfo(existing, app)!;
    expect(out).toContain('# owned by payments');
    const docs = parseAllDocuments(out).map(d => d.toJS());
    expect(docs).toHaveLength(2);
    expect(docs[1].metadata.annotations).toEqual({
      'backstage.io/techdocs-ref': 'dir:.',
      'daas.io/app': 'payments/checkout-api',
    });
    expect(docs[1].spec.owner).toBe('team-payments');
  });

  it('changes nothing when the annotation is already right', () => {
    const existing = upsertCatalogInfo(undefined, app)!;
    expect(upsertCatalogInfo(existing, app)).toBeUndefined();
  });
});
