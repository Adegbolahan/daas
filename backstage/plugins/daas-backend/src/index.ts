/**
 * DAAS backend for Backstage.
 *
 * ```ts
 * backend.add(import('@internal/plugin-daas-backend'));              // /api/daas
 * backend.add(catalogModuleDaasTemplates);                            // generated templates
 * backend.add(scaffolderModuleDaas);                                  // daas:* actions
 * ```
 *
 * @packageDocumentation
 */
export { daasPlugin as default, catalogModuleDaasTemplates, scaffolderModuleDaas } from './plugin';
export { DaasClient, DaasApiError } from './service/DaasClient';
export { buildTemplates } from '@internal/plugin-daas-common';
export { daasIncludes, mergeGitlabCi } from './actions/ci';
