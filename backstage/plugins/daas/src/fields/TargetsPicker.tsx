import { ButtonIcon, Checkbox, Text } from '@backstage/ui';
import { RiArrowDownLine, RiArrowUpLine } from '@remixicon/react';
import { stageIndex, targetOptions, teamByName } from '../data';
import { useDaas } from '../hooks';
import { CloudBadge } from '../components/ui';
import { DaasFieldProps, FieldShell, fieldText } from './FieldShell';

type Target = { provider: 'gke' | 'eks'; region: string };
const key = (t: Target) => `${t.provider}/${t.region}`;

/**
 * Where the app runs: the team's provider/region pairs, in rollout order.
 * The first target is the canary when the rollout is sequential.
 */
export function TargetsPicker(props: DaasFieldProps<Target[]>) {
  const platform = useDaas(api => api.platform(), []);
  const teamName = props.formContext?.formData?.team as string | undefined;
  const team = teamByName(platform.value, teamName);
  // In a stage override, offer only the regions where the team has a cluster for that stage.
  const stage = (props.uiSchema?.['ui:options'] as { stage?: string } | undefined)?.stage;
  const options = targetOptions(team, stage);
  const order = stageIndex(platform.value);
  // RJSF pre-fills arrays with minItems using empty objects; those aren't targets yet.
  const value = (props.formData ?? []).filter(t => t?.provider && t?.region);
  const selected = new Set(value.map(key));
  const unknown = value.filter(v => !options.some(o => key(o) === key(v)));
  const disabled = props.disabled || props.readonly;

  const toggle = (t: Target, on: boolean) =>
    props.onChange(on ? [...value, { provider: t.provider, region: t.region }] : value.filter(v => key(v) !== key(t)));
  const move = (i: number, by: number) => {
    const next = [...value];
    const [item] = next.splice(i, 1);
    next.splice(i + by, 0, item);
    props.onChange(next);
  };

  return (
    <FieldShell {...fieldText(props)}>
      {!teamName ? (
        <Text variant="body-small" color="secondary">
          Choose the team first; its clusters decide which targets are available.
        </Text>
      ) : !options.length ? (
        <Text variant="body-small" color="warning">
          {stage
            ? `Team ${teamName} has no cluster in ${stage}.`
            : `Team ${teamName} has no clusters yet. Add them to its clusters.yaml in the platform repository.`}
        </Text>
      ) : (
        <div className="daas-targets">
          {options.map(o => {
            const stages = [...new Set(o.clusters.map(c => c.stage))].sort(
              (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
            );
            return (
              <div key={key(o)} className={`daas-target-opt${selected.has(key(o)) ? ' is-on' : ''}`}>
                <Checkbox isSelected={selected.has(key(o))} isDisabled={disabled} onChange={on => toggle(o, on)}>
                  <span className="daas-target-opt__body">
                    <CloudBadge provider={o.provider} region={o.region} />
                    <Text variant="body-x-small" color="secondary">
                      {stages.join(' · ')}
                    </Text>
                  </span>
                </Checkbox>
              </div>
            );
          })}
        </div>
      )}
      {value.length > 0 && (
        <ol className="daas-order">
          {value.map((t, i) => (
            <li key={key(t)}>
              <span className="daas-order__n">{i + 1}</span>
              <CloudBadge provider={t.provider} region={t.region} />
              {i === 0 && value.length > 1 && <span className="daas-tier">first · canary</span>}
              {unknown.includes(t) && (
                <Text variant="body-x-small" color="warning">
                  No {teamName} cluster here; skipped or rejected depending on the stage
                </Text>
              )}
              <span className="daas-order__spacer" />
              <ButtonIcon
                aria-label="Move up"
                size="small"
                variant="tertiary"
                icon={<RiArrowUpLine />}
                isDisabled={disabled || i === 0}
                onPress={() => move(i, -1)}
              />
              <ButtonIcon
                aria-label="Move down"
                size="small"
                variant="tertiary"
                icon={<RiArrowDownLine />}
                isDisabled={disabled || i === value.length - 1}
                onPress={() => move(i, 1)}
              />
            </li>
          ))}
        </ol>
      )}
    </FieldShell>
  );
}
