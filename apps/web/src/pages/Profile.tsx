import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ROLE } from '../lib/format';
import type { Scores } from '../lib/types';
import { Avatar, Icon, Skeleton } from '../ui/kit';
import { ScoresView } from '../ui/Scores';
import { go, useApp } from '../ui/state';

export function Profile() {
  const { session, theme, setTheme, can } = useApp();
  const u = session.user;
  const scores = useQuery({ queryKey: ['scores', u.id], queryFn: () => api<Scores>(`/members/${u.id}/scores`) });
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="card row" style={{ gap: 14 }}>
        <Avatar name={name} src={u.photoUrl} size={60} />
        <div className="grow">
          <div className="xb" style={{ fontSize: 20 }}>{name}</div>
          <div className="small muted">{u.username ? `@${u.username} · ` : ''}{session.ctx.company.name}</div>
          <div className="xs" style={{ color: 'var(--accent-ink)', marginTop: 2 }}>{session.ctx.roles.map((r) => ROLE[r] ?? r).join(', ')}</div>
        </div>
      </div>
      {scores.isPending ? <Skeleton h={120} n={3} /> : scores.data ? <ScoresView s={scores.data} /> : null}
      <div className="card list">
        <div className="list-item" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          <span className="grow b">{theme === 'dark' ? 'Yorug‘ mavzu' : 'Qorong‘i mavzu'}</span>
        </div>
        {(can('settings.company') || can('settings.department')) && (
          <div className="list-item" onClick={() => go('settings')}>
            <Icon name="settings" />
            <span className="grow b">Kompaniya sozlamalari</span>
            <Icon name="chevron" size={16} />
          </div>
        )}
      </div>
      {!u.canDm && (
        <div className="banner warn">
          <Icon name="alert" />
          <div>Eslatmalar shaxsiy chatga kelishi uchun botga <b>/start</b> yozing.</div>
        </div>
      )}
    </div>
  );
}
