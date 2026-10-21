import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBeforeUnload, useBlocker } from 'react-router';
import { workspaceSummarySchema } from '../contracts/workspace.ts';
import { readWorkspace, WorkspaceRequestError } from '../client/workspace.ts';
import { errorMessage, request, type Asset, type CodexModel, type RunAction } from './api.ts';

export function useWorkspaceSummary() {
  return useQuery({ queryKey: ['workspace', 'summary'], queryFn: ({ signal }) => readWorkspace('summary', workspaceSummarySchema, signal), staleTime: 30_000 });
}

export function useModels() {
  return useQuery({ queryKey: ['models'], queryFn: () => request<CodexModel[]>('models'), staleTime: 300_000 });
}

export function useAssets() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['assets'], queryFn: () => request<Asset[]>('assets/library'), staleTime: 30_000 });
  const onUpload = (asset: Asset) => client.setQueryData<Asset[]>(['assets'], current => [...(current ?? []).filter(item => item.id !== asset.id), asset]);
  return { ...query, onUpload };
}

export function useCommandIds() {
  const commands = useRef(new Map<string, string>());
  return (intent: string) => {
    const existing = commands.current.get(intent); if (existing) return existing;
    const id = crypto.randomUUID(); commands.current.set(intent, id); return id;
  };
}

/** Each mounted work area owns its progress and message; an upload cannot lock unrelated pages. */
export function useWorkspaceAction(scope?: readonly unknown[]) {
  const client = useQueryClient();
  const [notice, setNotice] = useState('');
  const mutation = useMutation({
    mutationFn: async ({ task, message }: { task: () => Promise<unknown>; message: string }) => { await task(); return message; },
    onSuccess: async message => {
      setNotice(message);
      await client.invalidateQueries({ queryKey: scope ?? ['workspace'] });
      if (!scope) await client.invalidateQueries({ queryKey: ['video-project'] });
    },
    onError: async error => {
      if (error instanceof WorkspaceRequestError && error.status === 409) {
        await client.invalidateQueries({ queryKey: ['workspace'] });
        await client.invalidateQueries({ queryKey: ['video-project'] });
      }
    },
    retry: false,
  });
  const perform: RunAction = async (task, message) => {
    setNotice('');
    await mutation.mutateAsync({ task, message });
  };
  const action: RunAction = async (task, message) => { try { await perform(task, message); } catch { /* The local error state remains visible. */ } };
  return { action, perform, busy: mutation.isPending, notice, error: mutation.error ? errorMessage(mutation.error) : '' };
}

export function ActionNotice({ notice, error }: { notice: string; error: string }) {
  return <>{error ? <div role="alert" className="alert error">{error}</div> : null}{notice ? <div role="status" className="alert success">{notice}</div> : null}</>;
}

const DirtyContext = createContext<((id: string, dirty: boolean, save?: () => Promise<void>) => void) | null>(null);
const HasDirtyContext = createContext(false);
const CommittedNavigationContext = createContext<() => void>(() => {});
export function useHasUnsavedChanges(): boolean { return useContext(HasDirtyContext); }
export function useCommittedNavigation(): () => void { return useContext(CommittedNavigationContext); }
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Record<string, boolean>>({});
  const committed=useRef(false);const allowCommittedNavigation=useCallback(()=>{committed.current=true;},[]);
  const saves = useRef(new Map<string,() => Promise<void>>()); const [saveError,setSaveError] = useState(''); const [saving,setSaving] = useState(false);
  const register = useCallback((id: string, value: boolean, save?: () => Promise<void>) => { if (value && save) saves.current.set(id,save); else saves.current.delete(id); setEntries(current => {
    if ((current[id] ?? false) === value) return current;
    const next = { ...current }; if (value) next[id] = true; else delete next[id]; return next;
  }); }, []);
  const dirty = useMemo(() => Object.values(entries).some(Boolean), [entries]);
  useBeforeUnload(useCallback((event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } }, [dirty]));
  const blocker = useBlocker(({currentLocation,nextLocation}) => {
    if(committed.current){committed.current=false;return false;}
    if (!dirty) return false;
    const task = /^\/tasks\/(plan|video|article)\/[^/]+/u.exec(currentLocation.pathname)?.[0];
    const current = new URLSearchParams(currentLocation.search); const next = new URLSearchParams(nextLocation.search);
    return !(task && nextLocation.pathname.startsWith(`${task}/`) && current.get('episode') === next.get('episode') && current.get('article') === next.get('article'));
  });
  const saveAndLeave = async () => {
    setSaving(true);setSaveError('');
    try { for (const save of saves.current.values()) await save(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); if (saves.current.size) throw new Error('保存尚未完成，请继续编辑并处理提示。'); if (blocker.state === 'blocked') blocker.proceed(); }
    catch (error) { setSaveError(errorMessage(error)); } finally {setSaving(false);}
  };
  return <DirtyContext.Provider value={register}><HasDirtyContext.Provider value={dirty}><CommittedNavigationContext.Provider value={allowCommittedNavigation}>{children}</CommittedNavigationContext.Provider></HasDirtyContext.Provider>{blocker.state === 'blocked' ? <div role="alertdialog" aria-modal="true" aria-label="未保存修改" className="unsaved-dialog" onKeyDown={event => { if (event.key === 'Escape' && !saving) blocker.reset(); if(event.key === 'Tab') { const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const target = event.shiftKey ? buttons.at(-1) : buttons[0];if ((event.shiftKey && document.activeElement === buttons[0]) || (!event.shiftKey && document.activeElement === buttons.at(-1))) {event.preventDefault();target?.focus();} } }}><p>当前修改尚未保存。</p>{saveError ? <p role="alert">{saveError}</p> : null}<button autoFocus disabled={saving} onClick={() => blocker.reset()}>继续编辑</button>{saves.current.size === Object.keys(entries).length ? <button disabled={saving} onClick={() => void saveAndLeave()}>保存并离开</button> : null}<button disabled={saving} onClick={() => blocker.proceed()}>放弃修改并离开</button></div> : null}</DirtyContext.Provider>;
}
export function UnsavedChanges({ dirty, onSave }: { dirty: boolean; onSave?: () => Promise<void> }) {
  const register = useContext(DirtyContext); const id = useId(); const save = useRef(onSave); save.current = onSave; const canSave = Boolean(onSave);
  useEffect(() => { register?.(id, dirty, canSave ? async () => { await save.current?.(); } : undefined); return () => register?.(id, false); }, [register, id, dirty, canSave]);
  return null;
}
