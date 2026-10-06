import {
  Alert,
  Button,
  ButtonIcon,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  PasswordField,
  Select,
  Text,
  TextField,
} from '@backstage/ui';
import { RiAddLine, RiDeleteBinLine, RiKey2Line, RiRefreshLine } from '@remixicon/react';
import type { SecretListItem, TeamView } from '@internal/plugin-daas-common';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { parse } from 'yaml';
import { stageIndex, teamByName } from '../data';
import { useScope } from '../scope';
import { timeAgo } from '../format';
import { useDaas, useDaasApi } from '../hooks';
import { DataTable, EmptyState, ErrorState, LoadingBlock, Mono, Section, StatusBadge } from './ui';

const OTHER = '__other__';
const NAME = /^[A-Z][A-Z0-9_]*$/;

type Row = SecretListItem & { declared: boolean; set: boolean };

export function SecretsPage() {
  const [params, setParams] = useSearchParams();
  const platform = useDaas(api => api.platform(), []);
  const { mine } = useScope();
  // The user's own teams first, and the first of them preselected.
  const teams = [...(platform.value?.teams ?? [])].sort(
    (a, b) => Number(!mine.includes(a.name)) - Number(!mine.includes(b.name)) || a.name.localeCompare(b.name),
  );
  const team =
    teamByName(platform.value, params.get('team') ?? '') ??
    (mine.length ? teamByName(platform.value, mine[0]) : teams.length === 1 ? teams[0] : undefined);
  const apps = useDaas(api => (team ? api.apps(team.name) : Promise.resolve([])), [team?.name]);
  const [other, setOther] = useState(false);
  const app = params.get('app') ?? '';
  const knownApps = (apps.value ?? []).map(a => a.app);
  const reserved = platform.value?.conventions.platformSecretsApp ?? 'daas';
  const isOther = other || (!!app && !!apps.value && app !== reserved && !knownApps.includes(app));

  const stages = useMemo(() => {
    const order = stageIndex(platform.value);
    return Object.keys(team?.stages ?? {}).sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
  }, [team, platform.value]);
  const stage = params.get('stage') && stages.includes(params.get('stage')!) ? params.get('stage')! : stages[0];

  const set = (key: string, value?: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  if (platform.error) return <ErrorState error={platform.error} onRetry={platform.reload} />;
  if (!platform.value) return <LoadingBlock rows={6} />;

  return (
    <div className="daas-stack">
      <Alert
        status="info"
        icon
        title="Secret values are write-only"
        description="DAAS stores them in the stage’s own GCP project or AWS account and never returns them. Apps read them through External Secrets, wherever they run."
      />
      <div className="daas-toolbar">
        <Select
          label="Team"
          size="small"
          className="daas-toolbar__select"
          placeholder="Choose a team"
          options={teams.map(t => ({
            id: t.name,
            label: t.name,
            description: mine.includes(t.name) ? 'Your team' : undefined,
          }))}
          value={team?.name ?? null}
          onChange={k => set('team', k ? String(k) : undefined)}
        />
        <Select
          label="App"
          size="small"
          className="daas-toolbar__select"
          placeholder="Choose an app"
          isDisabled={!team}
          options={[
            ...knownApps.map(a => ({ id: a, label: a })),
            {
              id: reserved,
              label: `${reserved} (platform-owned)`,
              description: 'Secrets DAAS itself uses for the team, e.g. REGISTRY_AUTH',
            },
            { id: OTHER, label: 'Another app…', description: 'Set secrets before an app’s first deployment' },
          ]}
          value={isOther ? OTHER : app || null}
          onChange={k => {
            setOther(k === OTHER);
            set('app', k && k !== OTHER ? String(k) : undefined);
          }}
        />
        {isOther && (
          <TextField
            label="App name"
            size="small"
            value={app}
            onChange={v => set('app', v.trim() || undefined)}
            placeholder="payments-api"
          />
        )}
        <Select
          label="Stage"
          size="small"
          className="daas-toolbar__select"
          isDisabled={!team}
          options={stages.map(s => ({ id: s, label: s }))}
          value={stage ?? null}
          onChange={k => set('stage', k ? String(k) : undefined)}
        />
      </div>
      {team && app && stage ? (
        <SecretsTable team={team} app={app} stage={stage} reserved={reserved} />
      ) : (
        <EmptyState title="Pick a team, an app and a stage">
          Each stage keeps its own secrets, in that stage’s cloud project or account.
        </EmptyState>
      )}
    </div>
  );
}

function SecretsTable({
  team,
  app,
  stage,
  reserved,
}: {
  team: TeamView;
  app: string;
  stage: string;
  reserved: string;
}) {
  const api = useDaasApi();
  const secrets = useDaas(a => a.listSecrets(stage, team.name, app), [stage, team.name, app]);
  const spec = useDaas(
    a => (app === reserved ? Promise.resolve(undefined) : a.appSpec(team.name, app).catch(() => undefined)),
    [team.name, app],
  );
  const [editing, setEditing] = useState<{ name?: string; provider?: 'gcp' | 'aws' } | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);

  const declared = useMemo(() => {
    const out = new Map<string, 'gcp' | 'aws' | undefined>();
    try {
      const doc = spec.value ? parse(spec.value.spec) : undefined;
      for (const s of (doc?.secrets ?? []) as (string | { name: string; from?: 'gcp' | 'aws' })[]) {
        if (typeof s === 'string') out.set(s, undefined);
        else if (s?.name) out.set(s.name, s.from);
      }
    } catch {
      /* not parseable: nothing declared */
    }
    return out;
  }, [spec.value]);

  const rows: Row[] = useMemo(() => {
    const present = (secrets.value ?? []).map(s => ({ ...s, declared: declared.has(s.name), set: true }));
    const names = new Set(present.map(s => s.name));
    const missing = [...declared.entries()]
      .filter(([n]) => !names.has(n))
      .map(([name, from]) => ({
        name,
        provider: from ?? team.secretsProvider,
        key: '',
        updated: null,
        declared: true,
        set: false,
      }));
    return [...missing, ...present].sort((a, b) => Number(a.set) - Number(b.set) || a.name.localeCompare(b.name));
  }, [secrets.value, declared, team.secretsProvider]);

  const missingCount = rows.filter(r => !r.set).length;

  return (
    <Section
      title={`${app} · ${stage}`}
      description={
        missingCount
          ? `${missingCount} secret${missingCount === 1 ? '' : 's'} declared in daas.yaml ${missingCount === 1 ? 'isn’t' : 'aren’t'} set for this stage yet. Deployments to ${stage} will fail until ${missingCount === 1 ? 'it is' : 'they are'}.`
          : `Default provider for ${team.name}: ${team.secretsProvider === 'gcp' ? 'GCP Secret Manager' : 'AWS Secrets Manager'}.`
      }
      actions={
        <>
          <ButtonIcon
            aria-label="Refresh"
            variant="tertiary"
            size="small"
            icon={<RiRefreshLine />}
            onPress={secrets.reload}
          />
          <Button size="small" variant="primary" iconStart={<RiAddLine />} onPress={() => setEditing({})}>
            Add secret
          </Button>
        </>
      }
    >
      {secrets.error ? (
        <ErrorState error={secrets.error} onRetry={secrets.reload} />
      ) : !secrets.value ? (
        <LoadingBlock />
      ) : (
        <DataTable
          rows={rows}
          rowKey={r => `${r.provider}/${r.name}`}
          empty={
            <EmptyState
              title="No secrets yet"
              action={
                <Button size="small" onPress={() => setEditing({})}>
                  Add the first one
                </Button>
              }
            >
              Declare them under <Mono>secrets:</Mono> in daas.yaml, then set their values here.
            </EmptyState>
          }
          columns={[
            {
              key: 'name',
              label: 'Name',
              render: r => (
                <span className="daas-inline">
                  <RiKey2Line size={14} aria-hidden />
                  <Mono>{r.name}</Mono>
                </span>
              ),
            },
            {
              key: 'state',
              label: 'State',
              render: r =>
                r.set ? (
                  r.declared ? (
                    <StatusBadge status="succeeded" label="Set" />
                  ) : (
                    <StatusBadge status="committed" label="Set · not in daas.yaml" />
                  )
                ) : (
                  <StatusBadge status="failed" label="Missing" />
                ),
            },
            {
              key: 'provider',
              label: 'Stored in',
              render: r => (
                <Text variant="body-small">{r.provider === 'gcp' ? 'GCP Secret Manager' : 'AWS Secrets Manager'}</Text>
              ),
            },
            { key: 'key', label: 'Key', render: r => (r.key ? <Mono>{r.key}</Mono> : '—') },
            {
              key: 'updated',
              label: 'Updated',
              render: r => (
                <Text variant="body-small" color="secondary">
                  {timeAgo(r.updated)}
                </Text>
              ),
            },
            {
              key: 'actions',
              label: '',
              align: 'right',
              render: r => (
                <span className="daas-inline daas-inline--end">
                  <Button
                    size="small"
                    variant={r.set ? 'secondary' : 'primary'}
                    onPress={() => setEditing({ name: r.name, provider: r.provider })}
                  >
                    {r.set ? 'Rotate' : 'Set value'}
                  </Button>
                  {r.set && (
                    <ButtonIcon
                      aria-label={`Delete ${r.name}`}
                      size="small"
                      variant="tertiary"
                      icon={<RiDeleteBinLine />}
                      onPress={() => setDeleting(r)}
                    />
                  )}
                </span>
              ),
            },
          ]}
        />
      )}

      <SetSecretDialog
        open={!!editing}
        initial={editing ?? {}}
        defaultProvider={team.secretsProvider}
        where={`${team.name} / ${app} / ${stage}`}
        onClose={() => setEditing(null)}
        onSave={async (name, value, provider) => {
          await api.putSecret(stage, team.name, app, name, value, provider);
          setEditing(null);
          secrets.reload();
        }}
      />

      <Dialog isOpen={!!deleting} onOpenChange={o => !o && setDeleting(null)} width={440}>
        <DialogHeader>Delete {deleting?.name}?</DialogHeader>
        <DialogBody>
          <Text as="p" variant="body-medium">
            The value is removed from {deleting?.provider === 'aws' ? 'AWS Secrets Manager' : 'GCP Secret Manager'} for{' '}
            <strong>{stage}</strong>. Running pods keep the old value until they restart; new deployments that still
            declare it will fail.
          </Text>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onPress={() => setDeleting(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            destructive
            onPress={async () => {
              if (!deleting) return;
              await api.deleteSecret(stage, team.name, app, deleting.name, deleting.provider);
              setDeleting(null);
              secrets.reload();
            }}
          >
            Delete secret
          </Button>
        </DialogFooter>
      </Dialog>
    </Section>
  );
}

function SetSecretDialog({
  open,
  initial,
  defaultProvider,
  where,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: { name?: string; provider?: 'gcp' | 'aws' };
  defaultProvider: 'gcp' | 'aws';
  where: string;
  onClose: () => void;
  onSave: (name: string, value: string, provider: 'gcp' | 'aws') => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [provider, setProvider] = useState<'gcp' | 'aws'>(defaultProvider);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) {
      setName(initial.name ?? '');
      setValue('');
      setProvider(initial.provider ?? defaultProvider);
      setError(undefined);
    }
  }, [open, initial.name, initial.provider, defaultProvider]);

  const nameError =
    name && !NAME.test(name) ? 'Upper case letters, digits and underscores, starting with a letter' : undefined;
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onSave(name, value, provider);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog isOpen={open} onOpenChange={o => !o && onClose()} width={480}>
      <DialogHeader>{initial.name ? `Set ${initial.name}` : 'Add a secret'}</DialogHeader>
      <DialogBody>
        <div className="daas-form">
          <Text variant="body-small" color="secondary">
            {where}
          </Text>
          <TextField
            label="Name"
            value={name}
            onChange={v => setName(v.toUpperCase())}
            isReadOnly={!!initial.name}
            isInvalid={!!nameError}
            description={nameError ?? 'Exposed to the app as an environment variable of the same name.'}
            placeholder="DATABASE_URL"
          />
          <PasswordField label="Value" value={value} onChange={setValue} />
          <Select
            label="Stored in"
            options={[
              { id: 'gcp', label: 'GCP Secret Manager' },
              { id: 'aws', label: 'AWS Secrets Manager' },
            ]}
            value={provider}
            onChange={k => k && setProvider(k as 'gcp' | 'aws')}
            description={provider === defaultProvider ? 'The team default.' : 'Declare it with from: in daas.yaml too.'}
          />
          {error && <Alert status="danger" icon title="DAAS didn’t store the secret" description={error} />}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          Cancel
        </Button>
        <Button variant="primary" isDisabled={!name || !!nameError || !value} isPending={busy} onPress={save}>
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
