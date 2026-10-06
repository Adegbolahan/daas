import { Button, ButtonIcon, TextField } from '@backstage/ui';
import { RiAddLine, RiCloseLine } from '@remixicon/react';
import { useState } from 'react';
import { DaasFieldProps, FieldShell, fieldText } from './FieldShell';

type Scalar = string | number | boolean;
type Row = { id: number; key: string; value: string };

let seq = 0;
const toRows = (v?: Record<string, Scalar>): Row[] =>
  Object.entries(v ?? {}).map(([key, value]) => ({ id: seq++, key, value: String(value) }));

/** A map of names to values (env vars, labels, annotations). Rows keep their order while you type. */
export function KeyValueField(props: DaasFieldProps<Record<string, Scalar>>) {
  const [rows, setRows] = useState<Row[]>(() => toRows(props.formData));
  const disabled = props.disabled || props.readonly;
  const placeholder = (props.uiSchema?.['ui:options'] as { keyPlaceholder?: string } | undefined)?.keyPlaceholder;
  const isEnv = /env/i.test(props.idSchema?.$id ?? '') || /environment/i.test(props.schema.title ?? '');

  const emit = (next: Row[]) => {
    setRows(next);
    const out: Record<string, Scalar> = {};
    for (const r of next) if (r.key.trim()) out[r.key.trim()] = r.value;
    props.onChange(Object.keys(out).length ? out : undefined);
  };
  const dupes = new Set(rows.map(r => r.key.trim()).filter((k, i, all) => k && all.indexOf(k) !== i));

  return (
    <FieldShell {...fieldText(props)}>
      <div className="daas-kv">
        {rows.map((r, i) => (
          <div key={r.id} className="daas-kv__row">
            <TextField
              aria-label="Name"
              size="small"
              placeholder={placeholder ?? (isEnv ? 'LOG_LEVEL' : 'name')}
              value={r.key}
              isDisabled={disabled}
              isInvalid={dupes.has(r.key.trim())}
              onChange={v => emit(rows.map((x, j) => (j === i ? { ...x, key: isEnv ? v.toUpperCase() : v } : x)))}
            />
            <TextField
              aria-label="Value"
              size="small"
              placeholder="value"
              value={r.value}
              isDisabled={disabled}
              onChange={v => emit(rows.map((x, j) => (j === i ? { ...x, value: v } : x)))}
            />
            <ButtonIcon
              aria-label={`Remove ${r.key || 'row'}`}
              size="small"
              variant="tertiary"
              icon={<RiCloseLine />}
              isDisabled={disabled}
              onPress={() => emit(rows.filter((_, j) => j !== i))}
            />
          </div>
        ))}
        <div>
          <Button
            size="small"
            variant="tertiary"
            iconStart={<RiAddLine />}
            isDisabled={disabled}
            onPress={() => setRows([...rows, { id: seq++, key: '', value: '' }])}
          >
            Add
          </Button>
        </div>
      </div>
    </FieldShell>
  );
}
