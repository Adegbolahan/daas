import { createFormField, FormFieldBlueprint } from '@backstage/plugin-scaffolder-react/alpha';
import { DAAS_FIELDS } from '@internal/plugin-daas-common';

/** Scaffolder form fields used by the generated DAAS templates (names come from DAAS_FIELDS). */
export const daasFormFields = [
  FormFieldBlueprint.make({
    name: 'team-picker',
    params: {
      field: () =>
        import('./TeamPicker').then(m => createFormField({ name: DAAS_FIELDS.team, component: m.TeamPicker as any })),
    },
  }),
  FormFieldBlueprint.make({
    name: 'targets-picker',
    params: {
      field: () =>
        import('./TargetsPicker').then(m =>
          createFormField({ name: DAAS_FIELDS.targets, component: m.TargetsPicker as any }),
        ),
    },
  }),
  FormFieldBlueprint.make({
    name: 'key-value',
    params: {
      field: () =>
        import('./KeyValueField').then(m =>
          createFormField({ name: DAAS_FIELDS.keyValue, component: m.KeyValueField as any }),
        ),
    },
  }),
  FormFieldBlueprint.make({
    name: 'secrets-editor',
    params: {
      field: () =>
        import('./SecretsEditor').then(m =>
          createFormField({ name: DAAS_FIELDS.secrets, component: m.SecretsEditor as any }),
        ),
    },
  }),
  FormFieldBlueprint.make({
    name: 'spec-preview',
    params: {
      field: () =>
        import('./SpecPreview').then(m =>
          createFormField({ name: DAAS_FIELDS.preview, component: m.SpecPreview as any }),
        ),
    },
  }),
];
