import { useCallback, useEffect, useRef, useState } from 'react';
import { initialState, type Fixture, type StudioState } from '../types';
import {sampleSource} from '@comictoons/core';

class ApiError extends Error {}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(detail?.error || `The studio couldn’t connect (${response.status}). Try again.`);
  }
  return response.json() as Promise<T>;
}

export function useStudio(recapId?: string) {
  const [state, setState] = useState<StudioState>(initialState);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');
  const mounted = useRef(true);
  const busyRef = useRef(false);
  // Views fed by the /api/events stream pause the 800ms poll while that stream is healthy.
  const pollingPaused = useRef(false);
  const requestSequence = useRef(0);
  const sampleCache = useRef<StudioState|undefined>(undefined);
  const sampleRevision=useRef(0);
  const [sampleReady,setSampleReady] = useState(false);
  const path = recapId ? `/api/recaps/${encodeURIComponent(recapId)}` : '/api/state';

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const next = await api<StudioState>(path);
      if (!mounted.current || sequence !== requestSequence.current) return;
      setState({ ...initialState, ...next });
      if (next.source?.active!=='twitch' && (next.panels.length || next.pendingPanels.length)) {
        sampleCache.current=structuredClone(next);sampleRevision.current++;setSampleReady(true);
      }
      setOffline(false);
      setError('');
    } catch (cause) {
      if (mounted.current && sequence === requestSequence.current) {
        setOffline(!(cause instanceof ApiError));
        setError(cause instanceof Error ? cause.message : 'The studio is offline. Check the demo server and retry.');
      }
    } finally {
      if (mounted.current && sequence === requestSequence.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    let polling = false;
    const interval = setInterval(() => {
      if (polling || busyRef.current || pollingPaused.current) return;
      polling = true;
      void refresh().finally(() => { polling = false; });
    }, 800);
    void api<Fixture[]>('/api/fixtures').then(setFixtures).catch(() => {});
    return () => { mounted.current = false; clearInterval(interval); };
  }, [refresh]);

  useEffect(()=>{
    if(recapId)return;
    let cancelled=false;
    const revision=sampleRevision.current;
    void api<StudioState>('/api/ingest/sample').then(snapshot=>{
      if(!cancelled&&mounted.current&&revision===sampleRevision.current){sampleCache.current=snapshot;setSampleReady(true);}
    }).catch(()=>{});
    return()=>{cancelled=true;};
  },[recapId,state.fixtureId,state.style]);

  const mutate = useCallback(async <T,>(path: string, body: unknown = {}) => {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    requestSequence.current += 1;
    setBusy(path);
    setActionError('');
    try {
      const result = await api<T>(path, body);
      await refresh();
      return result;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'That change couldn’t be saved. Try again.');
      throw cause;
    } finally { busyRef.current = false; setBusy(''); }
  }, [refresh]);

  const useSampleData = useCallback(async()=>{
    if(busyRef.current||!sampleCache.current)return;
    const previous=state;
    const sample=structuredClone(sampleCache.current);
    const savedUrl=state.latestRecapUrl??state.recapUrl??sample.latestRecapUrl??sample.recapUrl;
    // The preloaded sample is painted in this click, before the POST resolves.
    // A cache made before saving must not hide the current saved issue.
    setState({...sample,latestRecapUrl:savedUrl,savedIssueDiffers:(sample.latestRecapUrl??sample.recapUrl)===savedUrl?sample.savedIssueDiffers:undefined,mangaTheme:state.mangaTheme,source:{...sampleSource(),reason:'manual'}});
    try {await mutate('/api/ingest',{mode:'sample'});}
    catch(cause){if(mounted.current)setState(previous);throw cause;}
  },[mutate,state]);

  const retry = useCallback(async () => { setActionError(''); await refresh(); }, [refresh]);
  const pausePolling = useCallback((paused: boolean) => { pollingPaused.current = paused; }, []);
  return { state, fixtures, loading, offline, error: actionError || error, busy, mutate, sampleReady, useSampleData, refresh: retry, pausePolling };
}
export type Studio = ReturnType<typeof useStudio>;
