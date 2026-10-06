import { Alert, Button, Flex, Skeleton, Text } from '@backstage/ui';
import {
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiErrorWarningFill,
  RiIndeterminateCircleLine,
  RiLoader4Line,
  RiRefreshLine,
} from '@remixicon/react';
import { Fragment, ReactNode } from 'react';
import { STATUS_LABEL, statusTone, Tone } from '../format';
import '../daas.css';

const TONE_ICON: Record<Tone, ReactNode> = {
  success: <RiCheckboxCircleFill size={14} aria-hidden />,
  danger: <RiCloseCircleFill size={14} aria-hidden />,
  warning: <RiErrorWarningFill size={14} aria-hidden />,
  info: <RiLoader4Line size={14} aria-hidden className="daas-spin" />,
  neutral: <RiIndeterminateCircleLine size={14} aria-hidden />,
};

/** Status is never color alone: icon + label, in the design system's status colors. */
export function StatusBadge({ status, label }: { status?: string; label?: string }) {
  const tone = statusTone(status);
  return (
    <span className={`daas-status daas-status--${tone}`}>
      {TONE_ICON[tone]}
      {label ?? STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status ?? 'Unknown'}
    </span>
  );
}

function GkeGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path d="M8 1.5 13.6 4.75v6.5L8 14.5 2.4 11.25v-6.5z" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  );
}

function EksGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <rect x="2" y="2" width="12" height="12" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5.5 5v6M5.5 8l4-3M5.5 8l4 3"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Cloud identity carries its name, not just a color. */
export function CloudBadge({ provider, region }: { provider: 'gke' | 'eks'; region?: string }) {
  return (
    <span className={`daas-cloud daas-cloud--${provider}`}>
      {provider === 'gke' ? <GkeGlyph /> : <EksGlyph />}
      <span className="daas-cloud__name">{String(provider ?? '?').toUpperCase()}</span>
      {region && <span className="daas-cloud__region">{region}</span>}
    </span>
  );
}

export function StagePill({ name, tier, preview }: { name: string; tier?: string; preview?: boolean }) {
  return (
    <span
      className={`daas-stage${preview ? ' daas-stage--preview' : ''}`}
      title={tier ? `GitLab tier: ${tier}` : undefined}
    >
      {name}
    </span>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="daas-mono">{children}</code>;
}

/** One headline number. */
export function Stat({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="daas-stat">
      <Flex align="center" gap="2">
        {icon && <span className="daas-stat__icon">{icon}</span>}
        <Text variant="body-small" color="secondary">
          {label}
        </Text>
      </Flex>
      <div className="daas-stat__value">{value}</div>
      {hint && (
        <Text variant="body-x-small" color="secondary">
          {hint}
        </Text>
      )}
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="daas-section">
      <div className="daas-section__head">
        <div>
          <Text as="h2" variant="title-x-small" weight="bold">
            {title}
          </Text>
          {description && (
            <Text as="p" variant="body-small" color="secondary">
              {description}
            </Text>
          )}
        </div>
        {actions && <Flex gap="2">{actions}</Flex>}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="daas-empty">
      <Text variant="body-medium" weight="bold">
        {title}
      </Text>
      {children && (
        <Text variant="body-small" color="secondary">
          {children}
        </Text>
      )}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const status = (error as { status?: number }).status;
  const hint =
    status === 403
      ? 'You don’t have access to this in DAAS. Your Backstage permissions or your Entra role for this team may be missing.'
      : status === 404
        ? 'Not found in DAAS.'
        : 'DAAS couldn’t be reached, or it returned an error.';
  return (
    <Alert
      status="danger"
      icon
      title={hint}
      description={error.message}
      customActions={
        onRetry && (
          <Button size="small" variant="secondary" iconStart={<RiRefreshLine />} onPress={onRetry}>
            Retry
          </Button>
        )
      }
    />
  );
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <Flex direction="column" gap="2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={i === 0 ? 28 : 18} width={i === 0 ? '40%' : `${90 - i * 7}%`} />
      ))}
    </Flex>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  width?: string;
  align?: 'left' | 'right';
  /** Let the cell's content wrap (cells don't wrap by default). */
  wrap?: boolean;
}

/** A quiet, readable table (recessive rules, tabular numbers). */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
}) {
  if (!rows.length) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  return (
    <div className="daas-table-wrap">
      <table className="daas-table">
        <thead>
          <tr>
            {columns.map(c => (
              <th key={c.key} style={{ width: c.width, textAlign: c.align ?? 'left' }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr
              key={rowKey(r)}
              className={onRowClick ? 'daas-table__row--link' : undefined}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
            >
              {columns.map(c => (
                <td
                  key={c.key}
                  className={c.wrap ? 'daas-table__wrap' : undefined}
                  style={{ textAlign: c.align ?? 'left' }}
                >
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** YAML with light, token-colored highlighting (keys, comments, strings, numbers). */
export function YamlBlock({ text, maxHeight = 420 }: { text: string; maxHeight?: number }) {
  const lines = text.replace(/\n$/, '').split('\n');
  return (
    <pre className="daas-code" style={{ maxHeight }}>
      {lines.map((line, i) => (
        <Fragment key={i}>
          <span className="daas-code__ln">{i + 1}</span>
          {highlight(line)}
          {'\n'}
        </Fragment>
      ))}
    </pre>
  );
}

function highlight(line: string): ReactNode {
  const comment = line.match(/^(\s*)(#.*)$/);
  if (comment)
    return (
      <>
        {comment[1]}
        <span className="daas-code__comment">{comment[2]}</span>
      </>
    );
  const kv = line.match(/^(\s*-?\s*)([\w./@-]+)(:)(\s*)(.*)$/);
  if (kv) {
    return (
      <>
        {kv[1]}
        <span className="daas-code__key">{kv[2]}</span>
        {kv[3]}
        {kv[4]}
        {yamlValue(kv[5])}
      </>
    );
  }
  const item = line.match(/^(\s*-\s+)(.*)$/);
  if (item)
    return (
      <>
        {item[1]}
        {yamlValue(item[2])}
      </>
    );
  return line;
}

function yamlValue(v: string): ReactNode {
  if (!v) return null;
  if (/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(v)) return <span className="daas-code__num">{v}</span>;
  if (/^["']/.test(v)) return <span className="daas-code__str">{v}</span>;
  return <span className="daas-code__val">{v}</span>;
}
