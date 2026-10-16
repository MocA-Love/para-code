// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ITaskBoardFlow, ITaskBoardSnapshot, ITaskBoardStep, ITaskBoardTask, TaskBoardAgentKind } from '@engine/paradisTaskBoard.js';
import { useApp } from '../context.js';
import { KIND, stepName } from '../format.js';
import { useStored } from '../hooks.js';
import { Icon, type IconName } from '../icons.js';

/** 共通の枠。Esc と背景のクリックで閉じ、開いたら最初の入力か主ボタンに合わせる。 */
export function Modal({ title, icon, children, footer, size, onClose }: { title: ReactNode; icon?: IconName; children: ReactNode; footer?: ReactNode; size?: 'lg' | 'xl'; onClose?: () => void }) {
	const app = useApp();
	const close = onClose ?? app.closeDialog;
	const ref = useRef<HTMLDivElement>(null);
	// スナップショットのたびに close が作り直されても、フォーカスを奪い直さないよう ref で持つ
	const closeRef = useRef(close);
	closeRef.current = close;
	useEffect(() => {
		const el = ref.current?.querySelector<HTMLElement>('[data-autofocus], textarea, input:not([type=checkbox]):not([type=radio]), .btn.primary');
		el?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				closeRef.current();
			}
		};
		document.addEventListener('keydown', onKey, true);
		return () => document.removeEventListener('keydown', onKey, true);
	}, []);
	return (
		<div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) { close(); } }}>
			<div className={`modal ${size ?? ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={ref}>
				<div className="modal-h">{icon && <Icon name={icon} />}{title}<button className="btn ghost icon sm" onClick={close} aria-label="閉じる"><Icon name="close" /></button></div>
				<div className="modal-b">{children}</div>
				{footer && <div className="modal-f">{footer}</div>}
			</div>
		</div>
	);
}

export function ConfirmDialog({ title, body, ok, danger, onOk }: { title: string; body: ReactNode; ok: string; danger?: boolean; onOk: () => void | Promise<unknown> }) {
	const app = useApp();
	const [busy, setBusy] = useState(false);
	return (
		<Modal title={title} footer={<>
			<button className="btn" onClick={app.closeDialog}>やめる</button>
			<button className={`btn primary ${danger ? 'danger solid' : ''}`} disabled={busy} onClick={async () => { setBusy(true); await onOk(); app.closeDialog(); }}>{ok}</button>
		</>}>{body}</Modal>
	);
}

function freeSlotName(snapshot: ITaskBoardSnapshot, flow: ITaskBoardFlow): string | undefined {
	const leased = snapshot.tasks.filter(t => t.place && !t.place.startsWith('manual:')).length;
	if (leased >= flow.workspace.maxRunning) {
		return undefined;
	}
	if (flow.workspace.kind === 'worktree') {
		return '新しいワークツリー';
	}
	return snapshot.slots.find(s => s.kind === 'clone-pool' && !s.leasedBy && !s.dirty && !s.missing)?.name;
}

export function issueRef(task: ITaskBoardTask): string {
	return task.issue ? `#${task.issue.number}「${task.title}」` : `「${task.title}」`;
}

/** 着手する。エージェントと最初の指示を決める。 */
export function StartDialog({ task, step, flow }: { task: ITaskBoardTask; step: ITaskBoardStep; flow: ITaskBoardFlow }) {
	const app = useApp();
	const [lastAgent, setLastAgent] = useStored<TaskBoardAgentKind>('lastAgent', 'claude');
	const fixed = step.agent === 'claude' || step.agent === 'codex' ? step.agent : undefined;
	const [agent, setAgent] = useState<TaskBoardAgentKind>(fixed ?? lastAgent);
	const [prompt, setPrompt] = useState((step.prompt ?? '').replace(/\{issue\}/g, issueRef(task)));
	const slot = freeSlotName(app.snapshot, flow);
	const index = flow.steps.findIndex(s => s.id === step.id);
	return (
		<Modal title={task.issue ? `#${task.issue.number} に着手する` : 'このタスクに着手する'} icon="play" footer={<>
			<button className="btn" onClick={app.closeDialog}>やめる</button>
			<button className="btn primary" onClick={async () => {
				setLastAgent(agent);
				app.closeDialog();
				await app.call('start', { taskId: task.id, stepId: step.id, agent, prompt: step.kind === 'agent' ? prompt : undefined });
			}}>{slot || step.kind !== 'agent' ? '開始' : '空き待ちに入れる'}</button>
		</>}>
			<div className="form">
				<label>工程</label>
				<span style={{ color: 'var(--text)' }}>{step.name}{index > 0 && <span className="faint">（前の {index} 工程を飛ばす）</span>}</span>
				<label>エージェント</label>
				<div>
					<div className="seg" role="radiogroup" aria-label="エージェント">
						{(['claude', 'codex'] as const).map(a => <button key={a} role="radio" aria-checked={agent === a} className={agent === a ? 'on' : ''} disabled={Boolean(fixed && fixed !== a)} onClick={() => setAgent(a)}>{a === 'claude' ? 'Claude Code' : 'Codex'}</button>)}
					</div>
					{fixed && <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>この工程は {fixed === 'codex' ? 'Codex' : 'Claude Code'} に決まっています</div>}
				</div>
				<label>作業場所</label>
				<span style={{ color: 'var(--text)' }}>{slot ?? 'なし'}{slot && <span className="faint">　{flow.workspace.kind === 'clone-pool' ? 'fetch して既定のブランチから新しいブランチを作る' : ''}</span>}</span>
				{step.kind === 'agent' && <>
					<label>最初の指示</label>
					<textarea className="input" value={prompt} onChange={e => setPrompt(e.target.value)} rows={4} />
					<span className="hint">終わったら board_complete_step で報告するよう、ボードが自動で書き足します</span>
				</>}
			</div>
			{!slot && step.kind === 'agent' && <div className="warn"><Icon name="warning" />作業場所か同時実行の枠（{flow.workspace.maxRunning}）が埋まっています。空き待ちに入れ、空いたら自動で始めます。</div>}
			{app.snapshot.runtime.agents === 'simulated' && <div className="warn" style={{ background: 'var(--gray-weak)', color: 'var(--muted)' }}><Icon name="info" />今はシミュレーションです。本物の Claude Code / Codex は起動しません。</div>}
			{app.snapshot.runtime.agents === 'para-code' && !app.snapshot.runtime.agentsConnected && <div className="warn"><Icon name="info" />Para Code につながっていません。Para Code を起動するまで、エージェントは始まらず失敗になります。</div>}
		</Modal>
	);
}

/** 差し戻す。理由はエージェントへの指示の頭に付く。 */
export function SendBackDialog({ task, flow, to }: { task: ITaskBoardTask; flow: ITaskBoardFlow; to?: string }) {
	const app = useApp();
	// 開いた時点の工程。送るまでに工程が進んでいたら、サーバーが断る
	const [from] = useState(task.step);
	const [attempt] = useState(task.attempt);
	const current = flow.steps.findIndex(s => s.id === task.step);
	const candidates = flow.steps.slice(0, Math.max(0, current));
	const fallback = flow.steps[current]?.onFail ?? [...candidates].reverse().find(s => s.kind === 'agent')?.id ?? candidates[0]?.id;
	const [target, setTarget] = useState(to ?? fallback ?? '');
	const [reason, setReason] = useState('');
	return (
		<Modal title="差し戻す" icon="undo" footer={<>
			<button className="btn" onClick={app.closeDialog}>やめる</button>
			<button className="btn primary" disabled={!target} onClick={async () => {
				app.closeDialog();
				await app.call('sendBack', { taskId: task.id, to: target, reason: reason.trim() || undefined, from, attempt }, { title: '差し戻しました', body: `${stepName(flow, target)}からやり直します`, tone: 'amber', taskId: task.id });
			}}>差し戻す</button>
		</>}>
			<div className="form">
				<label>戻す先</label>
				<select className="input" value={target} onChange={e => setTarget(e.target.value)}>
					{candidates.map(s => <option key={s.id} value={s.id}>{s.name}（{KIND[s.kind].label}）</option>)}
				</select>
				<label>理由</label>
				<textarea className="input" data-autofocus value={reason} onChange={e => setReason(e.target.value)} placeholder="例: テストが足りない。境界値のケースも足して" rows={4} />
				<span className="hint">理由はそのままエージェントへの指示の頭に付きます</span>
			</div>
		</Modal>
	);
}

export function AddTaskDialog() {
	const app = useApp();
	const [title, setTitle] = useState('');
	const [due, setDue] = useState('');
	const [body, setBody] = useState('');
	const submit = async () => {
		if (!title.trim()) {
			return;
		}
		app.closeDialog();
		const result = await app.call('addTask', { title: title.trim(), due: due || undefined, body: body.trim() || undefined }, { title: 'タスクを足しました', body: title.trim(), tone: 'green' });
		if (result) {
			app.openTask(result.id, 'issue');
		}
	};
	return (
		<Modal title="タスクを追加" icon="plus" footer={<>
			<button className="btn" onClick={app.closeDialog}>やめる</button>
			<button className="btn primary" disabled={!title.trim()} onClick={submit}>追加</button>
		</>}>
			<div className="form">
				<label>タイトル</label>
				<input className="input" value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { void submit(); } }} placeholder="何をするか" />
				<label>締切</label>
				<input className="input" type="date" value={due} onChange={e => setDue(e.target.value)} />
				<label>説明</label>
				<textarea className="input" value={body} onChange={e => setBody(e.target.value)} placeholder="Markdown で書けます（任意）" rows={4} />
			</div>
			<p className="faint" style={{ fontSize: 12, margin: 0 }}>Issue を作らず、ボードだけのタスクとして足します。GitHub の Issue は同期で入ります。</p>
		</Modal>
	);
}

/** タッチ操作やキーボードで工程を移す（ドラッグの代わり）。 */
export function MoveDialog({ task, flow, onPick }: { task: ITaskBoardTask; flow: ITaskBoardFlow; onPick: (to: string) => void }) {
	const app = useApp();
	const pos = task.step === 'todo' ? -1 : task.step === 'done' ? flow.steps.length : flow.steps.findIndex(s => s.id === task.step);
	const targets: { id: string; name: string; kind?: ITaskBoardStep['kind']; index: number }[] = [
		{ id: 'todo', name: '未着手', index: -1 },
		...flow.steps.map((s, i) => ({ id: s.id, name: s.name, kind: s.kind, index: i })),
		{ id: 'done', name: '完了', index: flow.steps.length },
	];
	const describe = (index: number) => {
		if (index === pos) {
			return '今の位置';
		}
		if (pos === -1) {
			return index === flow.steps.length ? '完了にする' : index === 0 ? '着手する' : `前の ${index} 工程を飛ばして着手`;
		}
		if (index === -1) {
			return '中止して未着手に戻す';
		}
		if (index === flow.steps.length) {
			return '完了にする';
		}
		if (index < pos) {
			return '差し戻す';
		}
		return index === pos + 1 ? '今の工程を終わったことにする' : `${index - pos - 1} 工程を飛ばす`;
	};
	return (
		<Modal title="工程を移す" icon="move">
			<div className="movelist">
				{targets.map(t => (
					<button key={t.id} disabled={t.index === pos} onClick={() => { app.closeDialog(); onPick(t.id); }}>
						<span className={`ring ${t.kind ?? (t.id === 'todo' ? 'source' : 'end')}`} />
						<span>{t.name}<br /><small>{describe(t.index)}</small></span>
						{t.kind && <span className={`kind ${t.kind === 'human' ? 'human' : ''}`}>{KIND[t.kind].label}</span>}
					</button>
				))}
			</div>
		</Modal>
	);
}

export function AdoptDialog({ sessionId, name }: { sessionId: string; name: string }) {
	const app = useApp();
	const [title, setTitle] = useState(`${name} の作業`);
	return (
		<Modal title="タスクに取り込む" icon="plus" footer={<>
			<button className="btn" onClick={app.closeDialog}>やめる</button>
			<button className="btn primary" disabled={!title.trim()} onClick={async () => {
				app.closeDialog();
				const r = await app.call('adoptManual', { sessionId, title: title.trim() }, { title: '取り込みました', body: title.trim(), tone: 'green' });
				if (r) {
					app.openTask(r.id, 'progress');
				}
			}}>取り込む</button>
		</>}>
			<p style={{ marginTop: 0 }}>手で起動したエージェントを、フローの「実装」の工程にいるタスクとして扱います。作業場所の枠は使いません。</p>
			<div className="form">
				<label>タイトル</label>
				<input className="input" value={title} onChange={e => setTitle(e.target.value)} />
			</div>
		</Modal>
	);
}

export function ImageDialog({ src, title }: { src: string; title: string }) {
	return (
		<Modal title={title} icon="art" size="xl">
			<img src={src} alt={title} style={{ width: '100%', borderRadius: 8, border: '1px solid var(--line)', marginBottom: 14, display: 'block' }} />
		</Modal>
	);
}

export function ShortcutsDialog() {
	const rows: [string, string][] = [
		['/', '絞り込みへ移る'],
		['n', 'タスクを追加'],
		['b・i・l・f', 'ボード・あなたの番・一覧・フローへ'],
		['1〜9', '詳細のタブを選ぶ'],
		['[ ・ ]', '前・次のタブ'],
		['Esc', '詳細やダイアログを閉じる'],
		['Enter', '選んでいるカードを開く'],
		['?', 'この一覧'],
	];
	return (
		<Modal title="キーボード" icon="keyboard">
			<div className="shortcuts">{rows.map(([k, d]) => <Fragment key={k}><kbd>{k}</kbd><span>{d}</span></Fragment>)}</div>
		</Modal>
	);
}
