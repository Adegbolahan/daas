import { Text } from '@backstage/ui';
import { useState } from 'react';
import { KeyValueField } from '../src/fields/KeyValueField';
import { SecretsEditor } from '../src/fields/SecretsEditor';
import { SpecPreview } from '../src/fields/SpecPreview';
import { TargetsPicker } from '../src/fields/TargetsPicker';
import { TeamPicker } from '../src/fields/TeamPicker';
import { checkoutFormValues } from './fixtures';

/** The DAAS scaffolder fields outside the scaffolder, wired to one shared form state. */
export function FieldsPlayground() {
  const [values, setValues] = useState<Record<string, any>>(checkoutFormValues);
  const bind = (key: string, title: string, help?: string) => ({
    formData: values[key],
    onChange: (v: unknown) => setValues(s => ({ ...s, [key]: v })),
    schema: { title },
    uiSchema: help ? { 'ui:help': help } : {},
    idSchema: { $id: `root_${key}` },
    formContext: { formData: values },
  });
  return (
    <div className="daas daas-body" style={{ maxWidth: 860 }}>
      <Text as="h1" variant="title-small" weight="bold">
        Scaffolder fields
      </Text>
      <Text as="p" variant="body-small" color="secondary" style={{ marginBottom: 24 }}>
        The widgets the generated DAAS templates use, sharing one form state.
      </Text>
      <TeamPicker
        {...bind('team', 'Team', 'The team that owns the app. Its access.yaml decides where it can deploy.')}
      />
      <TargetsPicker {...bind('targets', 'Targets', 'Where it runs, in rollout order. The first is the canary.')} />
      <KeyValueField {...bind('env', 'Environment variables')} />
      <SecretsEditor
        {...bind('secrets', 'Secrets', 'Exposed to the app as env vars. Values are set per stage in DAAS secrets.')}
      />
      <SpecPreview {...bind('previewSpec', 'Plan')} />
    </div>
  );
}
