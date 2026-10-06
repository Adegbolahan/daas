/**
 * DAAS frontend plugin.
 *
 * @packageDocumentation
 */
export { default } from './plugin';
export { daasApi, daasPage, daasEntityContent, daasTeamEntityContent } from './plugin';
export { daasApiRef, DaasClient, DaasError } from './api';
export type { DaasApi, UiConfig } from './api';
export { daasFormFields } from './fields';
export { rootRouteRef as daasRootRouteRef } from './routes';
export { DAAS_APP_ANNOTATION, DAAS_TEAM_ANNOTATION, isDaasApp } from './entity';
