import { createPermission } from '@backstage/plugin-permission-common';

/** Read the DAAS platform view, apps and deployment history. */
export const daasReadPermission = createPermission({
  name: 'daas.read',
  attributes: { action: 'read' },
});

/**
 * Manage secret values through DAAS. DAAS itself also checks the caller's Entra role
 * per team and stage; this permission only decides who sees the secrets UI at all.
 */
export const daasSecretsManagePermission = createPermission({
  name: 'daas.secrets.manage',
  attributes: { action: 'update' },
});

export const daasPermissions = [daasReadPermission, daasSecretsManagePermission];
