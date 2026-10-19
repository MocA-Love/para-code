// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ITaskBoardFlow, ITaskBoardManualSession, ITaskBoardTask, TaskBoardStepKind } from '@engine/paradisTaskBoard.js';
import { useTaskActions } from '../actions.js';
import { useApp } from '../context.js';
import { KIND, needs, stageMismatch, STATUS, taskActivity } from '../format.js';
import { usePhone, useStored } from '../hooks.js';
import { Icon } from '../icons.js';
import { AgentTag, DueChip, Elapsed, LabelChip, Menu, PrChip, Status, tone } from './atoms.js';
import { AdoptDialog } from './dialogs.js';

interface IColumn {
	readonly id: string;
	readonly name: string;
	readonly desc: string;
	readonly ring: TaskBoardStepKind | 'source' | 'end';
	readonly kind?: TaskBoardStepKind;
}

export function boardColumns(flow: ITaskBoardFlow, sourceLabel: string): IColumn[] {
	return [
		{ id: 'todo', name: 'アサイン済み・未着手', desc: sourceLabel, ring: 'source' },
		...flow.steps.map(s => ({ id: s.id, name: s.name, desc: KIND[s.kind].desc, ring: s.kind, kind: s.kind })),
		{ id: 'done', name: '完了', desc: 'マージ済み・完了にしたもの', ring: 'end' as const },
	];
}

function sortTasks(list: ITaskBoardTask[], columnId: string): ITaskBoardTask[] {
	if (columnId === 'todo') {
		return list.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || (a.priority ? 0 : 1) - (b.priority ? 0 : 1) || a.title.localeCompare(b.title));
	}
	if (columnId === 'done') {
		return list.sort((a, b) => b.updatedAt - a.updatedAt);
	}
	// 人の出番があるものを上に、その中では待っている時間が長い順
	return list.sort((a, b) => Number(needs(b)) - Number(needs(a)) || a.stepSince - b.stepSince);
}

export const Card = memo(function Card({ task, flow, selected }: { task: ITaskBoardTask; flow: ITaskBoardFlow; selected: boolean }) {
	const app = useApp();
	const actions = useTaskActions();
	const status = STATUS[task.status];
	const index = flow.steps.findIndex(s => s.id === task.step);
	const step = flow.steps[index];
	const place = task.place ? (task.place.startsWith('manual:') ? task.place.slice(7) : app.snapshot.slots.find(s => s.id === task.place)?.name ?? task.place) : undefined;
	const activity = taskActivity(task, flow);
	const ref = task.issue ? `${task.issue.repo} #${task.issue.number}` : task.source === 'adopted' ? '取り込んだタスク' : 'ボードのタスク';
	return (
		<div
			className={`card ${needs(task) ? `need ${status.tone === 'amber' ? 'amber' : ''}` : ''} ${selected ? 'sel' : ''}`}
			role="button"
			tabIndex={0}
			draggable
			data-task={task.id}
			aria-label={`${task.title}、${status.label}`}
			onClick={() => app.openTask(task.id)}
			onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); app.openTask(task.id); } }}
			onDragStart={e => { e.dataTransfer.setData('text/x-task', task.id); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging'); }}
			onDragEnd={e => e.currentTarget.classList.remove('dragging')}
		>
			<div className="card-ref">
				<Icon name={task.status === 'done' ? 'issueClosed' : 'issue'} size={13} />
				<span className="ellipsis">{ref}</span>
				<Menu label="タスクの操作" items={actions.menuItems(task)} trigger={(open, toggle) => (
					<button className="btn ghost icon sm menu-btn" aria-label="タスクの操作" aria-expanded={open} onClick={e => { e.stopPropagation(); toggle(); }}><Icon name="dots" /></button>
				)} />
			</div>
			<div className="card-title">{task.title}</div>
			{(task.due || task.priority || task.pr || task.labels.length > 0 || stageMismatch(task, flow)) && (
				<div className="chips">
					<DueChip due={task.due} />
					{task.priority && <span className={`chip ${/高|high|urgent|最/i.test(task.priority) ? 'p-high' : 'p-mid'}`}>{task.priority}</span>}
					{task.pr && <PrChip pr={task.pr} onClick={() => app.openTask(task.id, 'pr')} />}
					{stageMismatch(task, flow) && <span className="chip due soon" title="GitHub 側の軸の欄がボードの工程と違います。次に工程が進むときに書き戻します">GitHub 側: {task.projectStage}</span>}
					{task.labels.slice(0, 4).map(l => <LabelChip key={l.name} label={l} />)}
					{task.labels.length > 4 && <span className="chip">+{task.labels.length - 4}</span>}
				</div>
			)}
			{task.question && (task.status === 'question' || task.status === 'permission')
				? <div className="card-ask"><span className="clamp"><b>{task.status === 'permission' ? '許可' : '質問'}</b>{task.question.text}</span></div>
				: task.status === 'approval' ? <div className="card-note">{task.artifacts.filter(a => a.stepId !== 'shots').length ? `成果物 ${task.artifacts.length} 件を確認してください` : '承認を待っています'}</div>
					: activity && task.step !== 'todo' && task.step !== 'done' ? <div className={`card-note ${task.status === 'failed' ? 'err' : ''}`}>{activity}</div> : null}
			{task.step !== 'todo' && (
				<>
					<div className="progress" aria-hidden="true">
						{flow.steps.map((s, i) => <i key={s.id} className={i < index || task.step === 'done' ? 'done' : i === index ? 'now' : ''} style={i === index ? tone(status.tone) : undefined} />)}
					</div>
					<div className="card-foot">
						<Status status={task.status} />
						{task.agent && step?.kind === 'agent' && <AgentTag agent={task.agent} short />}
						<span className="grow" />
						{place && <span className="place" title="作業場所">{place}</span>}
						{task.step !== 'done' && <Elapsed since={task.stepSince} />}
					</div>
				</>
			)}
		</div>
	);
});

function Column({ column, tasks, flow, selectedId, onDropTask, doneLimit, onMore }: { column: IColumn; tasks: ITaskBoardTask[]; flow: ITaskBoardFlow; selectedId?: string; onDropTask: (taskId: string, to: string) => void; doneLimit?: number; onMore?: () => void }) {
	const [over, setOver] = useState(false);
	const shown = doneLimit !== undefined ? tasks.slice(0, doneLimit) : tasks;
	const attention = tasks.filter(needs).length;
	return (
		<section
			className={`col ${column.id === 'done' ? 'narrow' : ''} ${column.kind === 'human' ? 'human' : ''} ${over ? 'drop' : ''}`}
			data-col={column.id}
			aria-label={column.name}
			onDragOver={e => { if (e.dataTransfer.types.includes('text/x-task')) { e.preventDefault(); setOver(true); } }}
			onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setOver(false); } }}
			onDrop={e => { e.preventDefault(); setOver(false); const id = e.dataTransfer.getData('text/x-task'); if (id) { onDropTask(id, column.id); } }}
		>
			<div className="col-head">
				<div className="col-title">
					<span className={`ring ${column.ring}`} />
					<span className="name">{column.name}</span>
					{column.kind && <span className={`kind ${column.kind === 'human' ? 'human' : ''}`}>{KIND[column.kind].label}</span>}
					{attention > 0 && column.id !== 'todo' && <span className="badge" title="人の出番">{attention}</span>}
					<span className="col-count">{tasks.length}</span>
				</div>
				<div className="col-desc" title={column.desc}>{column.desc}</div>
			</div>
			<div className="col-body">
				{shown.length ? shown.map(t => <Card key={t.id} task={t} flow={flow} selected={t.id === selectedId} />) : (
					<div className="col-empty">{column.id === 'todo' ? 'アサインされた未着手はありません' : column.id === 'done' ? 'まだありません' : 'ここへドラッグ'}</div>
				)}
				{doneLimit !== undefined && tasks.length > doneLimit && <button className="col-more" onClick={onMore}>さらに {tasks.length - doneLimit} 件を表示</button>}
			</div>
		</section>
	);
}

export function Board() {
	const app = useApp();
	const actions = useTaskActions();
	const phone = usePhone();
	const snapshot = app.snapshot;
	const flow = snapshot.flows.find(f => f.id === snapshot.activeFlowId) ?? snapshot.flows[0];
	const [doneLimit, setDoneLimit] = useState(20);
	const boardRef = useRef<HTMLDivElement>(null);
	const [active, setActive] = useState(0);
	const source = snapshot.github.sourceLabel ?? (snapshot.github.mode === 'off' ? '見本の Issue' : 'GitHub');
	const columns = useMemo(() => boardColumns(flow, source), [flow, source]);
	const grouped = useMemo(() => {
		const map = new Map<string, ITaskBoardTask[]>(columns.map(c => [c.id, []]));
		for (const task of snapshot.tasks) {
			if (task.flowId !== flow.id && task.step !== 'todo') {
				continue;
			}
			if (!app.matches(task)) {
				continue;
			}
			map.get(task.step)?.push(task);
		}
		for (const [id, list] of map) {
			sortTasks(list, id);
		}
		return map;
	}, [snapshot.tasks, columns, flow.id, app]);

	const onDropTask = (taskId: string, to: string) => {
		const task = snapshot.tasks.find(t => t.id === taskId);
		if (task) {
			actions.move(task, to);
		}
	};

	// 電話: 横スクロールの位置から今の列を出す
	useEffect(() => {
		const el = boardRef.current;
		if (!phone || !el) {
			return;
		}
		const onScroll = () => setActive(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	}, [phone]);
	const jump = (i: number) => {
		const el = boardRef.current;
		el?.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
		setActive(i);
	};
	// 電話では最初に人の出番がある列（無ければ作業中のある列）を見せる
	const jumped = useRef(false);
	useEffect(() => {
		if (!phone || jumped.current || !boardRef.current) {
			return;
		}
		jumped.current = true;
		const first = columns.findIndex(c => (grouped.get(c.id) ?? []).some(needs));
		if (first > 0) {
			boardRef.current.scrollLeft = first * boardRef.current.clientWidth;
			setActive(first);
		}
	}, [phone, columns, grouped]);

	return (
		<div className="view board-view">
			{phone && (
				<nav className="colnav" aria-label="列">
					{columns.map((c, i) => {
						const list = grouped.get(c.id) ?? [];
						return (
							<button key={c.id} className={i === active ? 'on' : ''} onClick={() => jump(i)}>
								{list.some(needs) && c.id !== 'todo' && <span className="need" />}{c.name}<span className="n">{list.length}</span>
							</button>
						);
					})}
				</nav>
			)}
			<div className="board" ref={boardRef}>
				{columns.map(c => (
					<Column
						key={c.id}
						column={c}
						flow={flow}
						tasks={grouped.get(c.id) ?? []}
						selectedId={app.selectedId}
						onDropTask={onDropTask}
						doneLimit={c.id === 'done' ? doneLimit : undefined}
						onMore={() => setDoneLimit(n => n + 50)}
					/>
				))}
			</div>
		</div>
	);
}

/* ---------------- フロー外のエージェント ---------------- */

function ManualCard({ session }: { session: ITaskBoardManualSession }) {
	const app = useApp();
	const s = session.status === 'permission' ? STATUS.permission : session.status === 'question' ? STATUS.question : session.status === 'idle' ? STATUS.todo : STATUS.working;
	return (
		<div className={`mini ${session.status === 'permission' || session.status === 'question' ? 'need' : ''}`}>
			<div className="mini-top">
				<AgentTag agent={session.agent} />
				<span className="mini-name ellipsis" title={session.name}>{session.name}</span>
				<span className="grow" />
				<span className={`status ${s.tone === 'blue' ? 'live' : ''}`} style={tone(s.tone)}>{s.label}</span>
			</div>
			<div className="mini-text ellipsis" title={session.text}>{session.branch ? `${session.branch}　` : ''}{session.text}</div>
			<div className="mini-acts">
				{session.status === 'permission' && <>
					<button className="btn xs primary" onClick={() => void app.call('answerManual', { sessionId: session.id, allow: true }, { title: '許可しました', body: session.name, tone: 'blue' })}>許可</button>
					<button className="btn xs" onClick={() => void app.call('answerManual', { sessionId: session.id, allow: false })}>拒否</button>
				</>}
				<span className="grow" />
				<span className="faint" style={{ fontSize: 11.5 }}><Elapsed since={session.since} /></span>
				<button className="btn xs ghost" onClick={() => app.showDialog(<AdoptDialog sessionId={session.id} name={session.name} />)}>タスクに取り込む</button>
			</div>
		</div>
	);
}

export function Dock() {
	const app = useApp();
	const phone = usePhone();
	const [open, setOpen] = useStored('dockOpen', true);
	const manual = app.snapshot.manual;
	if (!manual.length) {
		return null;
	}
	const waiting = manual.filter(m => m.status === 'permission' || m.status === 'question').length;
	return (
		<div className={`dock ${open ? '' : 'closed'} ${phone ? 'phone' : ''}`}>
			<button className="dock-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				<Icon name="chevron" size={12} className="caret" />
				フロー外のエージェント（手で起動したもの）<span className="badge soft">{manual.length}</span>
				{waiting > 0 && <span className="status" style={tone('red')}>許可待ち {waiting}</span>}
			</button>
			<div className="dock-body">{manual.map(m => <ManualCard key={m.id} session={m} />)}</div>
		</div>
	);
}
