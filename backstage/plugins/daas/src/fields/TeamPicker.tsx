import { Select, Skeleton } from '@backstage/ui';
import { useDaas } from '../hooks';
import { DaasFieldProps, FieldShell, fieldText } from './FieldShell';

/** Pick one of the teams in the platform repository (with its namespace and stages as context). */
export function TeamPicker(props: DaasFieldProps<string>) {
  const platform = useDaas(api => api.platform(), []);
  const teams = platform.value?.teams ?? [];
  return (
    <FieldShell {...fieldText(props)}>
      {platform.loading && !platform.value ? (
        <Skeleton height={32} width="100%" />
      ) : (
        <Select
          aria-label={props.schema.title ?? 'Team'}
          placeholder="Choose a team"
          isDisabled={props.disabled || props.readonly}
          isInvalid={!!props.rawErrors?.length}
          options={teams.map(t => ({
            id: t.name,
            label: t.name,
            description: `${t.namespace} · ${Object.keys(t.stages).join(', ')}`,
          }))}
          value={props.formData ?? null}
          onChange={k => props.onChange(k ? String(k) : undefined)}
        />
      )}
    </FieldShell>
  );
}
