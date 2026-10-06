import { ReactNode } from 'react';

/**
 * Common frame for DAAS scaffolder fields: the label and the widget. The scaffolder's field
 * template already renders `ui:help` and validation errors below custom fields, so we don't.
 */
export function FieldShell({
  id,
  title,
  required,
  errors,
  children,
}: {
  id?: string;
  title?: string;
  help?: ReactNode;
  required?: boolean;
  errors?: string[];
  children: ReactNode;
}) {
  return (
    <fieldset className="daas daas-field" id={id} data-invalid={errors?.length ? true : undefined}>
      {title && (
        <legend className="daas-field__label">
          {title}
          {required && <span aria-hidden> *</span>}
        </legend>
      )}
      {children}
    </fieldset>
  );
}

// The props we use from the scaffolder's RJSF field props (kept loose on purpose).
export interface DaasFieldProps<T> {
  formData?: T;
  onChange: (value: T | undefined) => void;
  schema: { title?: string; description?: string; enum?: unknown[] };
  uiSchema?: Record<string, unknown>;
  rawErrors?: string[];
  required?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  idSchema?: { $id: string };
  formContext?: { formData?: Record<string, unknown> };
}

export function fieldText<T>(props: DaasFieldProps<T>) {
  return {
    id: props.idSchema?.$id,
    title: props.schema.title,
    help: (props.uiSchema?.['ui:help'] as string | undefined) ?? props.schema.description,
    required: props.required,
    errors: props.rawErrors,
  };
}
