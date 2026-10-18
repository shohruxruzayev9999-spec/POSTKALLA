import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { when } from '../lib/format';
import { Avatar, Empty, Icon, Skeleton, StatusPill } from '../ui/kit';
import { go } from '../ui/state';

interface SearchResult {
  tasks: Array<{ id: string; number: number; title: string; status: string; deadline: string; isPrivate: boolean; project: string | null; assignee: string; overdue: boolean }>;
  projects: Array<{ id: string; name: string; color: string; status: string; client: string | null }>;
  members: Array<{ userId: string; name: string; username: string | null; photoUrl: string | null; position: string | null; department: string | null }>;
}

/** One box over tasks, projects and people. */
export function Search() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const ready = /^#?\d+$/.test(debounced) || debounced.replace(/^#/, '').length >= 2;
  const r = useQuery({ queryKey: ['search', debounced], queryFn: () => api<SearchResult>('/search', { query: { q: debounced } }), enabled: ready });
  const total = r.data ? r.data.tasks.length + r.data.projects.length + r.data.members.length : 0;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <h1 className="page-title">Qidiruv</h1>
      <div style={{ position: 'relative' }}>
        <input className="input" autoFocus style={{ paddingLeft: 38 }} placeholder="Vazifa, #raqam, loyiha yoki xodim…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="faint" style={{ position: 'absolute', left: 12, top: 12 }}><Icon name="search" size={18} /></span>
      </div>

      {!ready ? (
        <div className="small muted">Kamida 2 ta harf yoki vazifa raqamini yozing (masalan #142).</div>
      ) : r.isPending ? (
        <Skeleton h={56} n={4} />
      ) : !total ? (
        <Empty icon="🔎" title="Hech narsa topilmadi">Boshqa so‘z bilan urinib ko‘ring.</Empty>
      ) : (
        <>
          {r.data!.tasks.length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="section-title">Vazifalar</div>
              {r.data!.tasks.map((t) => (
                <div key={t.id} className="card tight click stack" style={{ gap: 4 }} onClick={() => go('tasks', t.id)}>
                  <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
                    <div className="b" style={{ fontSize: 14, lineHeight: 1.3 }}>
                      <span className="faint">#{t.number}</span> {t.isPrivate && <span className="xs" style={{ color: 'var(--review)' }}>1:1 · </span>}{t.title}
                    </div>
                    <StatusPill status={t.status} />
                  </div>
                  <div className="small muted ellipsis">
                    {t.project ?? 'Loyihasiz'} · {t.assignee} · <span style={t.overdue ? { color: 'var(--danger)' } : undefined}>{when(t.deadline)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {r.data!.projects.length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="section-title">Loyihalar</div>
              {r.data!.projects.map((p) => (
                <div key={p.id} className="card tight click row" style={{ gap: 10 }} onClick={() => go('projects', p.id)}>
                  <span style={{ width: 10, height: 10, borderRadius: 99, background: p.color, flex: 'none' }} />
                  <div className="grow">
                    <div className="b small">{p.name}</div>
                    {p.client && <div className="xs muted">{p.client}</div>}
                  </div>
                  <Icon name="chevron" size={18} />
                </div>
              ))}
            </div>
          )}
          {r.data!.members.length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="section-title">Jamoa</div>
              {r.data!.members.map((m) => (
                <div key={m.userId} className="card tight click row" style={{ gap: 10 }} onClick={() => go('team', m.userId)}>
                  <Avatar name={m.name} src={m.photoUrl} size={32} />
                  <div className="grow">
                    <div className="b small">{m.name}</div>
                    <div className="xs muted">{[m.position, m.department, m.username ? `@${m.username}` : null].filter(Boolean).join(' · ')}</div>
                  </div>
                  <Icon name="chevron" size={18} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
