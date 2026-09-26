import { leftText, when } from '../lib/format';
import type { TaskListItem } from '../lib/types';
import { Avatar, StatusPill } from './kit';
import { go } from './state';

export function TaskRow({ t, showAssignee }: { t: TaskListItem; showAssignee?: boolean }) {
  const left = leftText(t.deadline);
  const closed = t.status === 'DONE' || t.status === 'CANCELLED';
  return (
    <div className="card tight click row" style={{ gap: 12, alignItems: 'stretch' }} onClick={() => go('tasks', t.id)}>
      <span className={`prio prio-${t.priority}`} />
      <div className="grow stack" style={{ gap: 4 }}>
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div className="b" style={{ fontSize: 14, lineHeight: 1.3 }}>
            <span className="faint">#{t.number}</span> {t.title}
          </div>
          {t.revision > 1 && <span className="xs xb" style={{ color: 'var(--warn)' }}>R{t.revision}</span>}
        </div>
        <div className="row between small">
          <span className="muted ellipsis">
            {t.project ?? 'Loyihasiz'} · {when(t.deadline)}
          </span>
          {!closed && t.overdue ? (
            <span className="xs xb" style={{ color: 'var(--danger)', whiteSpace: 'nowrap' }}>{left.text}</span>
          ) : (
            <StatusPill status={t.status} />
          )}
        </div>
        {showAssignee && (
          <div className="row small muted" style={{ gap: 6 }}>
            <Avatar name={t.assignee.name} src={t.assignee.photoUrl} size={20} /> {t.assignee.name}
          </div>
        )}
      </div>
    </div>
  );
}
