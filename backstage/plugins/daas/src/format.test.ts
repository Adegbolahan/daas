import { repoUrlFor, shortImage, statusTone, templatePath, timeAgo } from './format';

describe('format', () => {
  it('shortens digests and tags', () => {
    expect(shortImage('reg.io/acme/apps/checkout@sha256:0123456789abcdef0123')).toBe('checkout@0123456789ab');
    expect(shortImage('reg.io/acme/apps/checkout:1.2.3')).toBe('checkout:1.2.3');
    expect(shortImage(undefined)).toBe('—');
  });

  it('builds scaffolder paths and repo URLs', () => {
    expect(templatePath('/create', 'template:default/daas-update-app')).toBe(
      '/create/templates/default/daas-update-app',
    );
    expect(repoUrlFor('gitlab.acme.io', 'acme/payments/checkout')).toBe(
      'gitlab.acme.io?owner=acme%2Fpayments&repo=checkout',
    );
  });

  it('maps status to tones and relative times', () => {
    expect(statusTone('unhealthy')).toBe('danger');
    expect(statusTone('committed')).toBe('warning');
    expect(timeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5 min ago');
  });
});
