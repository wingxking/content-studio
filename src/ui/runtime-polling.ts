import { useEffect, useRef, useState } from 'react';
import { request } from './api.ts';

// Each mounted panel has one request at a time, and hidden tabs stop polling.
export function useRuntimePolling<T>(path: string, revision = 0): { data: T | null; error: string; loading: boolean } {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (pending.current || document.visibilityState === 'hidden') return;
      pending.current = true;
      try { const value = await request<T>(path); if (active) { setData(value); setError(''); } }
      catch { if (active) setError('运行摘要暂不可读取，请检查本地服务后重试。'); }
      finally { pending.current = false; if (active) setLoading(false); }
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') void poll(); };
    void poll(); const timer = window.setInterval(() => void poll(), 5000);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [path, revision]);
  return { data, error, loading };
}
