import { identityApiRef, useApi, useApiHolder } from '@backstage/frontend-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { parseEntityRef } from '@backstage/catalog-model';
import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { DAAS_TEAM_ANNOTATION } from './entity';

/**
 * The DAAS teams the signed-in user belongs to: their Backstage group memberships, mapped through
 * each Group's `daas.io/team` annotation (or its name). Visibility is not restricted; this only
 * decides what the pages show first.
 */
export function useMyTeams(): { teams: string[]; loading: boolean } {
  const identity = useApi(identityApiRef);
  const catalog = useApiHolder().get(catalogApiRef);
  const [state, setState] = useState<{ teams: string[]; loading: boolean }>({ teams: [], loading: true });
  useEffect(() => {
    let live = true;
    (async () => {
      const { ownershipEntityRefs } = await identity.getBackstageIdentity();
      const groups = ownershipEntityRefs.filter(r => r.toLowerCase().startsWith('group:'));
      let names = groups.map(r => parseEntityRef(r).name);
      if (catalog && groups.length) {
        try {
          const { items } = await catalog.getEntitiesByRefs({ entityRefs: groups });
          names = groups.map(
            (r, i) => items[i]?.metadata.annotations?.[DAAS_TEAM_ANNOTATION] ?? parseEntityRef(r).name,
          );
        } catch {
          /* the catalog is optional here: fall back to group names */
        }
      }
      return [...new Set(names)];
    })().then(
      teams => live && setState({ teams, loading: false }),
      () => live && setState({ teams: [], loading: false }),
    );
    return () => {
      live = false;
    };
  }, [identity, catalog]);
  return state;
}

export type ScopeMode = 'mine' | 'all';

interface Scope {
  mode: ScopeMode;
  setMode: (m: ScopeMode) => void;
  /** The user's teams (may be empty: then everything is shown). */
  mine: string[];
  loading: boolean;
  /** Whether a team is shown in the current mode. */
  inScope: (team: string) => boolean;
}

const ScopeContext = createContext<Scope | undefined>(undefined);
const STORAGE_KEY = 'daas.scope';

function readStored(): ScopeMode | undefined {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'all' || v === 'mine' ? v : undefined;
  } catch {
    return undefined;
  }
}

export function ScopeProvider({ children }: { children: ReactNode }) {
  const { teams, loading } = useMyTeams();
  const [chosen, setChosen] = useState<ScopeMode | undefined>(readStored);
  const mine = useMemo(() => teams, [teams]);
  // With no team memberships, "my teams" would be empty: show everything.
  const mode: ScopeMode = !mine.length ? 'all' : (chosen ?? 'mine');
  const value = useMemo<Scope>(
    () => ({
      mode,
      mine,
      loading,
      setMode: m => {
        setChosen(m);
        try {
          window.localStorage.setItem(STORAGE_KEY, m);
        } catch {
          /* private mode: remember for this visit only */
        }
      },
      inScope: team => mode === 'all' || mine.includes(team),
    }),
    [mode, mine, loading],
  );
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

/** Outside the DAAS page (entity tabs, fields) everything is in scope. */
export function useScope(): Scope {
  return (
    useContext(ScopeContext) ?? {
      mode: 'all',
      mine: [],
      loading: false,
      setMode: () => {},
      inScope: () => true,
    }
  );
}

export function ScopeToggle() {
  const { mode, setMode, mine } = useScope();
  if (!mine.length) return null;
  const label = mine.length <= 3 ? mine.join(', ') : `${mine.length} teams`;
  return (
    <div className="daas-segments daas-scope" role="radiogroup" aria-label="Show">
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'mine'}
        className={`daas-segment${mode === 'mine' ? ' is-on' : ''}`}
        onClick={() => setMode('mine')}
        title={mine.join(', ')}
      >
        My teams · {label}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'all'}
        className={`daas-segment${mode === 'all' ? ' is-on' : ''}`}
        onClick={() => setMode('all')}
      >
        All teams
      </button>
    </div>
  );
}
