import { Button, ButtonIcon, Select, TextField } from '@backstage/ui';
import { RiAddLine, RiCloseLine } from '@remixicon/react';
import { teamByName } from '../data';
import { useDaas } from '../hooks';
import { DaasFieldProps, FieldShell, fieldText } from './FieldShell';

type Item = string | { name: string; from?: 'gcp' | 'aws' };
const NAME = /^[A-Z][A-Z0-9_]*$/;
const DEFAULT = 'default';

const nameOf = (i: Item) => (typeof i === 'string' ? i : i.name);
const fromOf = (i: Item) => (typeof i === 'string' ? undefined : i.from);

/** Secret names the app reads as env vars, each from the team's default store or an explicit one. */
export function SecretsEditor(props: DaasFieldProps<Item[]>) {
  const platform = useDaas(api => api.platform(), []);
  const team = teamByName(platform.value, props.formContext?.formData?.team as string | undefined);
  const items = props.formData ?? [];
  const disabled = props.disabled || props.readonly;
  const teamDefault = team ? (team.secretsProvider === 'gcp' ? 'GCP' : 'AWS') : undefined;

  const set = (i: number, name: string, from?: string) => {
    const next = [...items];
    next[i] = from && from !== DEFAULT ? { name, from: from as 'gcp' | 'aws' } : name;
    props.onChange(next);
  };

  return (
    <FieldShell {...fieldText(props)}>
      <div className="daas-kv">
        {items.map((item, i) => {
          const name = nameOf(item);
          const bad = name !== '' && !NAME.test(name);
          return (
            <div key={i} className="daas-kv__row">
              <TextField
                aria-label="Secret name"
                size="small"
                placeholder="DATABASE_URL"
                value={name}
                isDisabled={disabled}
                isInvalid={bad}
                description={bad ? 'A–Z, 0–9 and _, starting with a letter' : undefined}
                onChange={v => set(i, v.toUpperCase(), fromOf(item))}
              />
              <Select
                aria-label="Stored in"
                size="small"
                isDisabled={disabled}
                options={[
                  { id: DEFAULT, label: teamDefault ? `Team default (${teamDefault})` : 'Team default' },
                  { id: 'gcp', label: 'GCP Secret Manager' },
                  { id: 'aws', label: 'AWS Secrets Manager' },
                ]}
                value={fromOf(item) ?? DEFAULT}
                onChange={k => set(i, name, String(k ?? DEFAULT))}
              />
              <ButtonIcon
                aria-label={`Remove ${name || 'secret'}`}
                size="small"
                variant="tertiary"
                icon={<RiCloseLine />}
                isDisabled={disabled}
                onPress={() => {
                  const next = items.filter((_, j) => j !== i);
                  props.onChange(next.length ? next : undefined);
                }}
              />
            </div>
          );
        })}
        <div>
          <Button
            size="small"
            variant="tertiary"
            iconStart={<RiAddLine />}
            isDisabled={disabled}
            onPress={() => props.onChange([...items, ''])}
          >
            Add secret
          </Button>
        </div>
      </div>
    </FieldShell>
  );
}
