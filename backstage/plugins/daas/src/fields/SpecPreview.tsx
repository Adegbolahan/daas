import { Alert, Button, Link, Text } from '@backstage/ui';
import { RiRefreshLine } from '@remixicon/react';
import { APP_SPEC_HEADER, formValuesToSpec, toYaml } from '@internal/plugin-daas-common';
import type { PreviewResult } from '@internal/plugin-daas-common';
import { useEffect, useMemo, useState } from 'react';
import { useDaas, useDaasApi } from '../hooks';
import { useLinks } from '../routes';
import { CloudBadge, LoadingBlock, Mono, YamlBlock } from '../components/ui';
import { DaasFieldProps, FieldShell, fieldText } from './FieldShell';

/**
 * The review step: renders the daas.yaml the merge request will contain, asks DAAS to validate it
 * for the chosen team and environment, and shows where each wave would land.
 */
export function SpecPreview(props: DaasFieldProps<string>) {
  const api = useDaasApi();
  const links = useLinks();
  const schemas = useDaas(a => a.schemas(), []);
  const values = props.formContext?.formData ?? {};
  const team = values.team as string | undefined;
  const environment = (values.environment as string | undefined) || 'production';

  const specYaml = useMemo(() => {
    if (!schemas.value) return undefined;
    return toYaml(formValuesToSpec(values, schemas.value.app), APP_SPEC_HEADER);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemas.value, JSON.stringify(values)]);

  const [result, setResult] = useState<PreviewResult>();
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [tab, setTab] = useState<string>('daas.yaml');

  useEffect(() => {
    if (!specYaml) return undefined;
    if (specYaml !== props.formData) props.onChange(specYaml);
    if (!team) return undefined;
    let live = true;
    setBusy(true);
    const t = setTimeout(() => {
      api
        .preview({ spec: specYaml, team, environment })
        .then(
          r => live && (setResult(r), setError(undefined)),
          e => live && setError(e),
        )
        .finally(() => live && setBusy(false));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specYaml, team, environment, tick]);

  const waves = useMemo(() => {
    const byWave = new Map<number, PreviewResult['plan']>();
    for (const p of result?.plan ?? []) byWave.set(p.wave, [...(byWave.get(p.wave) ?? []), p]);
    return [...byWave.entries()].sort(([a], [b]) => a - b);
  }, [result]);

  const tabs = ['daas.yaml', ...Object.keys(result?.manifests ?? {})];

  return (
    <FieldShell {...fieldText(props)} help={undefined}>
      <div className="daas daas-preview">
        {!team ? (
          <Alert status="warning" icon title="Choose a team on the first step to validate this app." />
        ) : error ? (
          <Alert
            status="danger"
            icon
            title="DAAS couldn’t validate the spec"
            description={error.message}
            customActions={
              <Button
                size="small"
                variant="secondary"
                iconStart={<RiRefreshLine />}
                onPress={() => setTick(t => t + 1)}
              >
                Retry
              </Button>
            }
          />
        ) : !result ? (
          <LoadingBlock rows={3} />
        ) : result.valid ? (
          <Alert
            status="success"
            icon
            isPending={busy}
            title={`Valid for ${team} in ${environment}${result.stage ? ` (stage ${result.stage})` : ''}`}
            description={`Deploys ${result.name ?? ''} to namespace ${result.namespace ?? ''} on ${result.plan.length} cluster${result.plan.length === 1 ? '' : 's'}. Nothing is deployed from here; the merge request is the next step.`}
          />
        ) : (
          <Alert
            status="danger"
            icon
            isPending={busy}
            title="DAAS would reject this spec"
            description={
              <ul className="daas-bullets">
                {result.errors.map(e => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            }
          />
        )}

        {result && (result.warnings.length > 0 || result.skippedTargets.length > 0) && (
          <Alert
            status="warning"
            icon
            title="Heads up"
            description={
              <ul className="daas-bullets">
                {result.warnings.map(w => (
                  <li key={w}>{w}</li>
                ))}
                {result.skippedTargets.length > 0 && (
                  <li>Skipped in this stage (the team has no cluster there): {result.skippedTargets.join(', ')}</li>
                )}
              </ul>
            }
          />
        )}

        {result && result.missingSecrets.length > 0 && (
          <Alert
            status="warning"
            icon
            title={`${result.missingSecrets.length} secret${result.missingSecrets.length === 1 ? ' isn’t' : 's aren’t'} set for ${result.stage ?? environment}`}
            description={
              <>
                {result.missingSecrets.map(s => (
                  <Mono key={s.name}>{s.name}</Mono>
                ))}{' '}
                · The deployment fails until they are.{' '}
                <Link
                  href={links.secrets({ team, app: result.name, stage: result.stage })}
                  target="_blank"
                  variant="body-small"
                >
                  Set them in DAAS secrets
                </Link>
              </>
            }
          />
        )}

        {waves.length > 0 && (
          <div>
            <Text as="h4" variant="body-medium" weight="bold">
              Rollout plan
            </Text>
            <ol className="daas-waves">
              {waves.map(([w, targets]) => (
                <li key={w} className="daas-wave">
                  <span className="daas-wave__label">Wave {w}</span>
                  <div className="daas-wave__targets">
                    {targets.map(t => (
                      <div key={t.cluster} className="daas-target">
                        <CloudBadge provider={t.provider} region={t.region} />
                        <Mono>{t.cluster}</Mono>
                        {t.hosts.map(h => (
                          <Text key={h} variant="body-x-small" color="secondary">
                            https://{h}
                          </Text>
                        ))}
                      </div>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        {specYaml && (
          <div>
            <div className="daas-segments" role="tablist" aria-label="Files">
              {tabs.map(t => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  className={`daas-segment${tab === t ? ' is-on' : ''}`}
                  onClick={() => setTab(t)}
                >
                  {t === 'daas.yaml' ? 'daas.yaml' : `${t} manifests`}
                </button>
              ))}
            </div>
            <YamlBlock text={tab === 'daas.yaml' ? specYaml : (result?.manifests[tab] ?? specYaml)} maxHeight={360} />
          </div>
        )}
      </div>
    </FieldShell>
  );
}
