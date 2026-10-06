import { stringify } from 'yaml';

/** Render a spec as YAML the way humans write it: two-space indent, no line folding, no anchors. */
export function toYaml(value: unknown, header?: string): string {
  const body = stringify(value, { indent: 2, lineWidth: 0, aliasDuplicateObjects: false });
  return header ? `${header.trimEnd()}\n${body}` : body;
}

export const APP_SPEC_HEADER =
  '# DAAS app spec. Schema: spec/daas.schema.json in the DAAS repo. Edited via Backstage or by hand.';
