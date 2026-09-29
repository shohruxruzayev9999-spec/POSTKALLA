import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { useDepartments } from '../lib/queries';
import { Avatar, Bar, Empty, Field, Icon, Ring, Sheet, Skeleton } from '../ui/kit';
import { go, useApp } from '../ui/state';

type BlockType = 'heading' | 'text' | 'callout' | 'checklist' | 'link' | 'video' | 'divider';
interface Block {
  id?: string;
  type: BlockType;
  text: string;
  items?: string[];
  url?: string;
  tone?: 'info' | 'warn' | 'good';
}
interface DocItem {
  id: string;
  title: string;
  emoji: string;
  color: string;
  published: boolean;
  version: number;
  departmentIds: string[];
  blockCount: number;
  forMe: boolean;
  acked: boolean;
  outdated: boolean;
  audience?: number;
  ackedCount?: number;
}
interface DocFull extends Omit<DocItem, 'blockCount' | 'forMe' | 'audience' | 'ackedCount'> {
  blocks: Block[];
  ackedAt: string | null;
  canEdit: boolean;
  readers?: Array<{ userId: string; name: string; photoUrl: string | null; ackedAt: string | null; outdated: boolean }>;
}

const COLORS = ['#34D399', '#A3E635', '#7AA7FF', '#B69BFF', '#F59E0B', '#FB7185', '#14B8A6', '#F472B6'];
const BLOCKS: Array<{ type: BlockType; label: string; icon: string }> = [
  { type: 'heading', label: 'Sarlavha', icon: 'H' },
  { type: 'text', label: 'Matn', icon: '¶' },
  { type: 'callout', label: 'Eslatma oynasi', icon: '💡' },
  { type: 'checklist', label: "Ro'yxat", icon: '☑' },
  { type: 'link', label: 'Havola', icon: '🔗' },
  { type: 'video', label: 'Video', icon: '▶' },
  { type: 'divider', label: 'Ajratkich', icon: '—' },
];

export function OnboardingDocs({ openId }: { openId?: string }) {
  const { can, fail, toast } = useApp();
  const qc = useQueryClient();
  const manager = can('onboarding.manage');
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['onboarding'], queryFn: () => api<DocItem[]>('/onboarding') });
  const starter = useMutation({
    mutationFn: () => api('/onboarding/starter', { method: 'POST' }),
    onSuccess: () => {
      toast('3 ta namunaviy hujjat qoralama sifatida yaratildi');
      void qc.invalidateQueries({ queryKey: ['onboarding'] });
    },
    onError: fail,
  });
  const docs = q.data ?? [];
  const mine = docs.filter((d) => d.forMe);
  const done = mine.filter((d) => d.acked).length;
  const pct = mine.length ? Math.round((done / mine.length) * 100) : null;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row wrap between" style={{ gap: 10 }}>
        <h1 className="page-title">Onboarding</h1>
        {manager && (
          <button className="btn primary sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> Hujjat
          </button>
        )}
      </div>

      {q.isPending ? (
        <Skeleton n={3} h={110} />
      ) : (
        <>
          {mine.length > 0 && (
            <div className="card row" style={{ gap: 16 }}>
              <Ring value={pct} size={80} stroke={9} tone={pct === 100 ? 'green' : 'amber'}>
                <div className="xb" style={{ fontSize: 18 }}>{done}/{mine.length}</div>
              </Ring>
              <div className="stack" style={{ gap: 4 }}>
                <div className="b">{pct === 100 ? 'Hammasi bilan tanishdingiz 🎉' : 'Siz uchun hujjatlar'}</div>
                <div className="small muted">{pct === 100 ? 'Yangi hujjat yoki o‘zgarish bo‘lsa, bot xabar beradi.' : `${mine.length - done} ta hujjatni o‘qib, «Tanishdim» ni bosing.`}</div>
              </div>
            </div>
          )}

          {docs.length === 0 ? (
            <div className="card">
              <Empty icon="📘" title="Hali hujjat yo'q">
                {manager ? (
                  <div className="stack" style={{ gap: 8, alignItems: 'center' }}>
                    <div className="small muted">Yangi hodimlar uchun qo‘llanma: kompaniya, qoidalar, vazifalar va KPI.</div>
                    <button className="btn primary sm" disabled={starter.isPending} onClick={() => starter.mutate()}>✨ Namunaviy qo‘llanma yaratish</button>
                  </div>
                ) : (
                  <div className="small muted">Rahbar hujjat qo‘shganda shu yerda paydo bo‘ladi.</div>
                )}
              </Empty>
            </div>
          ) : (
            <div className="ob-grid">
              {docs.map((d) => (
                <button key={d.id} className="ob-card" onClick={() => go('onboarding', d.id)} style={{ ['--c' as string]: d.color }}>
                  <div className="ob-cover"><span>{d.emoji}</span></div>
                  <div className="stack" style={{ gap: 6, padding: 14 }}>
                    <div className="b ellipsis2">{d.title}</div>
                    <div className="row wrap" style={{ gap: 6 }}>
                      {!d.published && <span className="tag">Qoralama</span>}
                      {d.forMe && (d.acked ? <span className="tag ok">✓ Tanishdim</span> : d.outdated ? <span className="tag warn">Yangilandi</span> : <span className="tag warn">O‘qilmagan</span>)}
                      <span className="xs faint">{d.blockCount} blok</span>
                    </div>
                    {d.audience != null && d.published && (
                      <div className="stack" style={{ gap: 4 }}>
                        <Bar value={d.audience ? ((d.ackedCount ?? 0) / d.audience) * 100 : 0} />
                        <span className="xs muted">{d.ackedCount}/{d.audience} kishi tanishdi</span>
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
          {manager && docs.length > 0 && docs.length < 3 && (
            <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} disabled={starter.isPending} onClick={() => starter.mutate()}>✨ Namunaviy hujjatlar qo‘shish</button>
          )}
        </>
      )}

      <Sheet open={!!openId} onClose={() => go('onboarding')} title={null} wide>
        {openId && <DocView id={openId} />}
      </Sheet>
      <Sheet open={creating} onClose={() => setCreating(false)} title="Yangi hujjat" wide>
        {creating && (
          <DocEditor
            onDone={(id) => {
              setCreating(false);
              if (id) go('onboarding', id);
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ reader

function DocView({ id }: { id: string }) {
  const { fail, toast } = useApp();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'read' | 'edit' | 'readers'>('read');
  const q = useQuery({ queryKey: ['onboarding', id], queryFn: () => api<DocFull>(`/onboarding/${id}`) });
  const ack = useMutation({
    mutationFn: () => api(`/onboarding/${id}/ack`, { method: 'POST' }),
    onSuccess: () => {
      toast('Rahmat! Tanishdingiz ✓');
      void qc.invalidateQueries({ queryKey: ['onboarding'] });
    },
    onError: fail,
  });
  if (!q.data) return <Skeleton n={4} />;
  const d = q.data;
  const unread = d.readers?.filter((r) => !r.ackedAt).length ?? 0;

  return (
    <div className="stack" style={{ gap: 14 }}>
      {d.canEdit && (
        <div className="seg" style={{ width: '100%', maxWidth: 420 }}>
          <button className={mode === 'read' ? 'on' : ''} onClick={() => setMode('read')}>O‘qish</button>
          <button className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')}>Tahrirlash</button>
          <button className={mode === 'readers' ? 'on' : ''} onClick={() => setMode('readers')}>Kim o‘qidi{d.readers ? ` · ${d.readers.length - unread}/${d.readers.length}` : ''}</button>
        </div>
      )}
      {mode === 'edit' ? (
        <DocEditor doc={d} onDone={() => setMode('read')} />
      ) : mode === 'readers' ? (
        <div className="stack" style={{ gap: 8 }}>
          {!d.published && <div className="card tight small muted">Hujjat hali nashr qilinmagan — hodimlar ko‘rmaydi.</div>}
          {(d.readers ?? []).map((r) => (
            <div key={r.userId} className="row" style={{ gap: 10 }}>
              <Avatar name={r.name} src={r.photoUrl} size={32} />
              <span className="grow b small">{r.name}</span>
              {r.ackedAt ? (
                <span className="xs" style={{ color: 'var(--accent-ink)', fontWeight: 700 }}>✓ {new Date(r.ackedAt).toLocaleDateString('ru-RU')}</span>
              ) : (
                <span className="xs" style={{ color: r.outdated ? 'var(--warn)' : 'var(--muted)', fontWeight: 700 }}>{r.outdated ? 'eski versiyani o‘qigan' : 'o‘qimagan'}</span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="ob-head" style={{ ['--c' as string]: d.color }}>
            <span className="ob-emoji">{d.emoji}</span>
            <div className="xb" style={{ fontSize: 24, lineHeight: 1.2 }}>{d.title}</div>
            {d.version > 1 && <span className="xs muted">{d.version}-versiya</span>}
          </div>
          <div className="stack ob-body" style={{ gap: 12 }}>
            {d.blocks.map((b, i) => <BlockView key={b.id ?? i} b={b} />)}
            {d.blocks.length === 0 && <div className="muted small">Hujjat bo‘sh. «Tahrirlash» orqali bloklar qo‘shing.</div>}
          </div>
          {d.published && (
            <div className="ob-ack">
              {d.acked ? (
                <div className="row" style={{ gap: 8, color: 'var(--accent-ink)', fontWeight: 800 }}>
                  <Icon name="check" size={20} /> Tanishdingiz{d.ackedAt ? ` · ${new Date(d.ackedAt).toLocaleDateString('ru-RU')}` : ''}
                </div>
              ) : (
                <button className="btn primary block" disabled={ack.isPending} onClick={() => ack.mutate()}>
                  <Icon name="check" size={18} /> {d.outdated ? 'Yangilangan versiya bilan tanishdim' : 'Tanishdim'}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function youtubeId(url: string) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/))([\w-]{11})/);
  return m?.[1] ?? null;
}

function BlockView({ b }: { b: Block }) {
  const [ticked, setTicked] = useState<number[]>([]);
  switch (b.type) {
    case 'heading':
      return <h3 className="ob-h">{b.text}</h3>;
    case 'text':
      return <p className="ob-p">{b.text}</p>;
    case 'callout':
      return (
        <div className={`ob-callout ${b.tone ?? 'info'}`}>
          <span>{b.tone === 'warn' ? '⚠️' : b.tone === 'good' ? '✅' : '💡'}</span>
          <div style={{ whiteSpace: 'pre-wrap' }}>{b.text}</div>
        </div>
      );
    case 'checklist':
      return (
        <div className="stack" style={{ gap: 6 }}>
          {b.text && <div className="b small">{b.text}</div>}
          {(b.items ?? []).map((it, i) => {
            const on = ticked.includes(i);
            return (
              <button key={i} className={`ob-check ${on ? 'on' : ''}`} onClick={() => setTicked(on ? ticked.filter((x) => x !== i) : [...ticked, i])}>
                <span className="ob-box">{on && <Icon name="check" size={14} />}</span>
                <span>{it}</span>
              </button>
            );
          })}
        </div>
      );
    case 'link':
      return b.url ? (
        <a className="ob-link" href={b.url} target="_blank" rel="noreferrer">
          <Icon name="link" size={18} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="b small">{b.text || b.url}</div>
            <div className="xs muted ellipsis">{b.url}</div>
          </div>
        </a>
      ) : null;
    case 'video': {
      const yt = b.url ? youtubeId(b.url) : null;
      return (
        <div className="stack" style={{ gap: 6 }}>
          {yt ? (
            <div className="ob-video"><iframe src={`https://www.youtube.com/embed/${yt}`} title={b.text || 'Video'} allowFullScreen /></div>
          ) : b.url ? (
            <a className="ob-link" href={b.url} target="_blank" rel="noreferrer"><span>▶</span><div className="b small grow">{b.text || 'Videoni ochish'}</div></a>
          ) : null}
          {yt && b.text && <div className="xs muted">{b.text}</div>}
        </div>
      );
    }
    case 'divider':
      return <hr className="ob-hr" />;
  }
}

// ------------------------------------------------------------------------------------------ editor

function DocEditor({ doc, onDone }: { doc?: DocFull; onDone: (id?: string) => void }) {
  const { fail, toast } = useApp();
  const qc = useQueryClient();
  const deps = useDepartments();
  const [title, setTitle] = useState(doc?.title ?? '');
  const [emoji, setEmoji] = useState(doc?.emoji ?? '📘');
  const [color, setColor] = useState(doc?.color ?? COLORS[0]!);
  const [departmentIds, setDeps] = useState<string[]>(doc?.departmentIds ?? []);
  const [blocks, setBlocks] = useState<Block[]>(doc?.blocks ?? [{ type: 'text', text: '' }]);
  const [published, setPublished] = useState(doc?.published ?? false);
  const [adding, setAdding] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const body = { title, emoji, color, departmentIds, published, blocks: blocks.map((b) => ({ ...b, url: b.url || undefined, items: b.type === 'checklist' ? (b.items ?? []).filter((x) => x.trim()) : undefined })) };
      return doc ? api<{ id: string }>(`/onboarding/${doc.id}`, { method: 'PATCH', body }) : api<{ id: string }>('/onboarding', { method: 'POST', body });
    },
    onSuccess: (r) => {
      toast(published ? 'Saqlandi — hodimlarga xabar boradi' : 'Qoralama saqlandi');
      void qc.invalidateQueries({ queryKey: ['onboarding'] });
      onDone(r.id);
    },
    onError: fail,
  });
  const del = useMutation({
    mutationFn: () => api(`/onboarding/${doc!.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast("O'chirildi");
      void qc.invalidateQueries({ queryKey: ['onboarding'] });
      go('onboarding');
    },
    onError: fail,
  });
  const set = (i: number, patch: Partial<Block>) => setBlocks(blocks.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setBlocks(next);
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <Field label="Belgi">
          <input className="input" style={{ width: 64, textAlign: 'center', fontSize: 22 }} value={emoji} maxLength={8} onChange={(e) => setEmoji(e.target.value)} />
        </Field>
        <div className="grow">
          <Field label="Sarlavha">
            <input className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Masalan: Kompaniya bilan tanishuv" />
          </Field>
        </div>
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        {COLORS.map((c) => (
          <button key={c} type="button" aria-label={c} onClick={() => setColor(c)} style={{ width: 26, height: 26, borderRadius: 13, background: c, border: color === c ? '3px solid var(--text)' : 0, cursor: 'pointer' }} />
        ))}
      </div>
      <div className="field">
        <span>Kim uchun</span>
        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className={`chip ${departmentIds.length === 0 ? 'on' : ''}`} onClick={() => setDeps([])}>Hammaga</button>
          {(deps.data ?? []).map((d) => {
            const on = departmentIds.includes(d.id);
            return (
              <button key={d.id} type="button" className={`chip ${on ? 'on' : ''}`} onClick={() => setDeps(on ? departmentIds.filter((x) => x !== d.id) : [...departmentIds, d.id])}>{d.name}</button>
            );
          })}
        </div>
      </div>

      <div className="section-title">Bloklar</div>
      <div className="stack" style={{ gap: 10 }}>
        {blocks.map((b, i) => (
          <div key={b.id ?? `n${i}`} className="ob-edit">
            <div className="row between" style={{ gap: 6 }}>
              <select className="input" style={{ width: 'auto', minHeight: 34, padding: '4px 8px', fontSize: 13 }} value={b.type} onChange={(e) => set(i, { type: e.target.value as BlockType })}>
                {BLOCKS.map((t) => (
                  <option key={t.type} value={t.type}>{t.icon} {t.label}</option>
                ))}
              </select>
              <div className="row" style={{ gap: 2 }}>
                <button className="btn sm ghost icon-btn" style={{ width: 30, height: 30 }} aria-label="Yuqoriga" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="btn sm ghost icon-btn" style={{ width: 30, height: 30 }} aria-label="Pastga" disabled={i === blocks.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button className="btn sm ghost icon-btn" style={{ width: 30, height: 30, color: 'var(--danger)' }} aria-label="O'chirish" onClick={() => setBlocks(blocks.filter((_, j) => j !== i))}><Icon name="trash" size={15} /></button>
              </div>
            </div>
            {b.type === 'divider' ? (
              <hr className="ob-hr" />
            ) : b.type === 'checklist' ? (
              <>
                <input className="input" placeholder="Ro‘yxat sarlavhasi (ixtiyoriy)" value={b.text} onChange={(e) => set(i, { text: e.target.value })} />
                <textarea className="input" placeholder={'Har bir band — yangi qatorda'} value={(b.items ?? []).join('\n')} onChange={(e) => set(i, { items: e.target.value.split('\n') })} style={{ minHeight: 90 }} />
              </>
            ) : (
              <>
                {b.type === 'heading' ? (
                  <input className="input" style={{ fontWeight: 800, fontSize: 17 }} placeholder="Sarlavha" value={b.text} onChange={(e) => set(i, { text: e.target.value })} />
                ) : (
                  <textarea className="input" placeholder={b.type === 'link' || b.type === 'video' ? 'Nomi (ixtiyoriy)' : 'Matn…'} value={b.text} onChange={(e) => set(i, { text: e.target.value })} style={{ minHeight: b.type === 'link' || b.type === 'video' ? 44 : 90 }} />
                )}
                {(b.type === 'link' || b.type === 'video') && (
                  <input className="input" placeholder={b.type === 'video' ? 'YouTube yoki boshqa video havolasi' : 'https://…'} value={b.url ?? ''} onChange={(e) => set(i, { url: e.target.value })} />
                )}
                {b.type === 'callout' && (
                  <div className="row" style={{ gap: 6 }}>
                    {(['info', 'warn', 'good'] as const).map((t) => (
                      <button key={t} type="button" className={`chip ${(b.tone ?? 'info') === t ? 'on' : ''}`} onClick={() => set(i, { tone: t })}>{t === 'info' ? '💡 Ma’lumot' : t === 'warn' ? '⚠️ Diqqat' : '✅ Yaxshi'}</button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      {adding ? (
        <div className="ob-add-menu">
          {BLOCKS.map((t) => (
            <button
              key={t.type}
              className="chip"
              onClick={() => {
                setBlocks([...blocks, { type: t.type, text: '', ...(t.type === 'checklist' ? { items: [''] } : {}), ...(t.type === 'callout' ? { tone: 'info' as const } : {}) }]);
                setAdding(false);
              }}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      ) : (
        <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>
          <Icon name="plus" size={15} /> Blok qo‘shish
        </button>
      )}

      <label className="row small" style={{ gap: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} style={{ width: 18, height: 18, accentColor: 'var(--accent)' }} />
        Nashr qilingan — hodimlar ko‘radi va «Tanishdim» bosadi
      </label>
      {doc?.published && <div className="xs muted">Matnni o‘zgartirsangiz, hamma yangi versiya bilan qayta tanishishi so‘raladi.</div>}
      <button className="btn primary block" disabled={!title.trim() || save.isPending} onClick={() => save.mutate()}>Saqlash</button>
      {doc && (
        <button className="btn danger block" disabled={del.isPending} onClick={() => del.mutate()}>
          <Icon name="trash" size={16} /> Hujjatni o'chirish
        </button>
      )}
    </div>
  );
}
