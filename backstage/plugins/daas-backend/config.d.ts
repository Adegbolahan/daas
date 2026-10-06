export interface Config {
  daas: {
    /** Base URL of the DAAS API, e.g. https://daas.example.com */
    baseUrl: string;
    auth?: {
      /**
       * Entra ID client credentials: the Backstage backend's own identity for read-only DAAS
       * calls (platform, apps, deployments, schemas, preview). Secret writes always use the
       * signed-in user's own Entra token instead.
       */
      entra?: {
        tenantId: string;
        clientId: string;
        /** @visibility secret */
        clientSecret: string;
        /** Default: api://daas/.default */
        scope?: string;
      };
      /**
       * Headers sent as-is (local development against DAAS_AUTH_MODE=dev only).
       */
      devHeaders?: { [name: string]: string };
    };
    gitlab: {
      /** GitLab host the app and platform repositories live on, e.g. gitlab.example.com */
      host: string;
      /** Scaffolder repoUrl of the DAAS platform repo, e.g. gitlab.example.com?owner=platform&repo=daas */
      platformRepoUrl: string;
      /** Path of the platform folder inside that repo. Default: platform */
      platformDir?: string;
      /** CI/CD catalog project of the DAAS components. Default: platform/daas-deploy */
      componentProject?: string;
      /** Component version to pin. Default: 1.0.0 */
      componentVersion?: string;
    };
    templates?: {
      /** Owner of the generated Template entities. Default: group:default/platform */
      owner?: string;
      /** How often to regenerate them from the DAAS schemas. Default: 10 minutes */
      refreshMinutes?: number;
    };
    /** Public DAAS URL used in CI includes. Default: baseUrl */
    publicUrl?: string;
    ui?: {
      /** Where the Scaffolder is mounted in the app. Default: /create */
      scaffolderPath?: string;
      /**
       * Entra scope the frontend requests for the signed-in user's token (secret calls).
       * Default: api://daas/.default when daas.auth.entra is set; none otherwise (DAAS dev mode).
       * @visibility frontend
       */
      secretsScope?: string;
    };
  };
}
