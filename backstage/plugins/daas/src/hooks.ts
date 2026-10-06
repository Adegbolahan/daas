import { useApi } from '@backstage/frontend-plugin-api';
import { DependencyList, useCallback, useEffect, useRef, useState } from 'react';
import { daasApiRef } from './api';

export interface Async<T> {
  value?: T;
  error?: Error;
  loading: boolean;
  reload: () => void;
}

/** Load data with a DaasApi call; re-runs when deps change, `reload()` refreshes in place. */
export function useDaas<T>(fn: (api: ReturnType<typeof useDaasApi>) => Promise<T>, deps: DependencyList): Async<T> {
  const api = useDaasApi();
  const [state, setState] = useState<{ value?: T; error?: Error; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let live = true;
    setState(s => ({ ...s, loading: true }));
    fnRef.current(api).then(
      value => live && setState({ value, loading: false }),
      error => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, tick, ...deps]);
  const reload = useCallback(() => setTick(t => t + 1), []);
  return { ...state, reload };
}

export function useDaasApi() {
  return useApi(daasApiRef);
}

/** Poll while something is in flight (e.g. a running deployment). */
export function useInterval(fn: () => void, ms: number | null) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (ms === null) return undefined;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}
