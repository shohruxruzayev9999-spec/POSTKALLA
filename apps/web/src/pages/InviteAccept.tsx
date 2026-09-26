import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { ROLE } from '../lib/format';
import { tg } from '../lib/tg';
import { Ring, Skeleton } from '../ui/kit';

export function InviteAccept({ token, onDone }: { token: string; onDone: (companyId: string | null) => void }) {
  const q = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<{ companyName: string; department: string | null; role: string; position: string | null; valid: boolean }>(`/invitations/${token}/preview`),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    try {
      const r = await api<{ companyId: string }>(`/invitations/${token}/accept`, { method: 'POST' });
      // Allow the bot to DM reminders.
      tg?.requestWriteAccess?.();
      onDone(r.companyId);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="main" style={{ maxWidth: 460, display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '100%' }}>
      {q.isPending ? (
        <Skeleton h={220} n={1} />
      ) : q.isError || !q.data ? (
        <div className="card stack" style={{ textAlign: 'center' }}>
          <div className="xb">Taklif topilmadi</div>
          <button className="btn" onClick={() => onDone(null)}>Davom etish</button>
        </div>
      ) : (
        <div className="card stack" style={{ alignItems: 'center', textAlign: 'center', gap: 14, padding: 24 }}>
          <Ring value={100} size={96} stroke={10}>
            <span style={{ fontSize: 30 }}>🤝</span>
          </Ring>
          <div className="muted small">Sizni taklif qilishdi</div>
          <h1 className="page-title">{q.data.companyName}</h1>
          <div className="muted">
            {ROLE[q.data.role] ?? q.data.role}
            {q.data.department ? ` · ${q.data.department}` : ''}
            {q.data.position ? ` · ${q.data.position}` : ''}
          </div>
          {!q.data.valid && <div className="banner danger">Havola muddati o‘tgan yoki ishlatilgan. Rahbaringizdan yangisini so‘rang.</div>}
          {error && <div className="banner danger">{error}</div>}
          <button className="btn primary block" disabled={!q.data.valid || busy} onClick={accept}>
            {busy ? 'Qo‘shilmoqda…' : 'Jamoaga qo‘shilish'}
          </button>
          <button className="btn ghost block" onClick={() => onDone(null)}>Keyinroq</button>
        </div>
      )}
    </div>
  );
}
