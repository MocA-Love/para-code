// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo, useState } from 'react';
import type { ITaskBoardTask, TaskBoardStatus } from '@engine/paradisTaskBoard.js';
import { useTaskActions } from '../actions.js';
import { useApp } from '../context.js';
import { dueInfo, errorText, needs, STATUS, stepName, taskActivity } from '../format.js';
import { useNow } from '../hooks.js';
import { Icon } from '../icons.js';
import { AgentTag, DueChip, Elapsed, LabelChip, PrChip, Status, tone } from './atoms.js';

const GROUPS: { status: TaskBoardStatus[]; label: string }[] = [
	{ status: ['question', 'permission'], label: '回答待ち' },
	{ status: ['approval'], label: '承認待ち' },
	{ status: ['failed'], label: '失敗' },
	{ status: ['stalled'], label: '報告なしで停止' },
	{ status: ['ready'], label: 'マージ待ち' },
];

function InboxRow({ task }: { task: ITaskBoardTask }) {
	const app = useApp();
	const actions = useTaskActions();
	const flow = app.flowOf(task);
	const [busy, setBusy] = useState(false);
	const act = async (fn: () => Promise<unknown> | void) => {
		setBusy(true);
		try {
			await fn();
		} finally {
			setBusy(false);
		}
	};
	let detail: React.ReactNode = null;
	let buttons: React.ReactNode = null;
	if ((task.status === 'question' || task.status === 'permission') && task.question) {
		detail = <div className="q">{task.question.text}</div>;
		buttons = task.question.options.slice(0, 3).map((o, i) => <button key={i} className="btn sm" disabled={busy} onClick={e => { e.stopPropagation(); void act(() => actions.answer(task, i)); }}>{o.label}</button>);
	} else if (task.status === 'approval') {
		const plan = task.artifacts.find(a => a.kind === 'plan');
		detail = <div className="q plain">{plan ? `計画「${plan.title}」` : '成果物'}を見て、承認か差し戻しを選んでください</div>;
		buttons = <>
			<button className="btn sm primary" disabled={busy} onClick={e => { e.stopPropagation(); void act(() => actions.approve(task)); }}>承認して次へ</button>
			<button className="btn sm" onClick={e => { e.stopPropagation(); actions.sendBack(task); }}>差し戻す</button>
		</>;
	} else if (task.status === 'failed') {
		detail = <div className="q">{taskActivity(task, flow) || errorText(task.error ?? '')}</div>;
		const back = flow.steps.find(s => s.id === task.step)?.onFail;
		buttons = <>
			{back && <button className="btn sm primary" onClick={e => { e.stopPropagation(); actions.sendBack(task, back); }}>{stepName(flow, back)}へ戻す</button>}
			<button className="btn sm" disabled={busy} onClick={e => { e.stopPropagation(); void act(() => app.call('retry', { taskId: task.id, from: task.step, attempt: task.attempt })); }}>やり直す</button>
		</>;
	} else if (task.status === 'stalled') {
		detail = <div className="q plain">{taskActivity(task, flow)}</div>;
		buttons = <>
			{task.error !== 'restarted' && <button className="btn sm primary" disabled={busy} onClick={e => { e.stopPropagation(); void act(() => app.call('nudge', { taskId: task.id })); }}>報告を促す</button>}
			{task.error === 'restarted' && <button className="btn sm primary" disabled={busy} onClick={e => { e.stopPropagation(); void act(() => app.call('retry', { taskId: task.id, from: task.step, attempt: task.attempt })); }}>工程をやり直す</button>}
			<button className="btn sm" onClick={e => { e.stopPropagation(); actions.move(task, flow.steps[flow.steps.findIndex(s => s.id === task.step) + 1]?.id ?? 'done'); }}>完了扱いにする</button>
		</>;
	} else if (task.status === 'ready') {
		detail = <div className="q plain">{task.pr ? `PR #${task.pr.number}　チェック ${task.pr.checksPassed ?? '-'} / ${task.pr.checksTotal ?? '-'}` : 'マージを待っています'}</div>;
		const url = actions.githubUrl(task);
		buttons = task.pr?.simulated || !url
			? <button className="btn sm primary" disabled={busy} onClick={e => { e.stopPropagation(); void act(() => app.call('markDone', { taskId: task.id }, { title: 'マージしました（シミュレーション）', body: task.title, tone: 'green' })); }}>マージ</button>
			: <a className="btn sm primary" href={url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}><Icon name="ext" />GitHub でマージ</a>;
	}
	return (
		<div className="irow" role="button" tabIndex={0} onClick={() => app.openTask(task.id)} onKeyDown={e => { if (e.key === 'Enter') { app.openTask(task.id); } }}>
			<div style={{ minWidth: 0 }}>
				<div className="card-ref">
					<Icon name="issue" size={13} />
					<span>{task.issue ? `#${task.issue.number}` : 'タスク'}　{stepName(flow, task.step)}</span>
					<Status status={task.status} />
					<span className="faint"><Elapsed since={task.question?.askedAt ?? task.stepSince} /></span>
					{task.agent && <AgentTag agent={task.agent} short />}
				</div>
				<div className="t">{task.title}</div>
				{detail}
			</div>
			<div className="acts">{buttons}<button className="btn sm ghost" onClick={e => { e.stopPropagation(); app.openTask(task.id); }}>開く</button></div>
		</div>
	);
}

export function Inbox() {
	const app = useApp();
	const now = useNow();
	const tasks = app.snapshot.tasks.filter(t => app.matches(t));
	const attention = tasks.filter(needs);
	const running = tasks.filter(t => ['working', 'preparing', 'waiting', 'queued'].includes(t.status));
	const soon = tasks.filter(t => t.step === 'todo' && dueInfo(t.due, now)?.level !== 'normal' && t.due).sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
	const manualWaiting = app.snapshot.manual.filter(m => m.status === 'permission' || m.status === 'question');
	const groups = useMemo(() => GROUPS.map(g => ({ ...g, tasks: attention.filter(t => g.status.includes(t.status)).sort((a, b) => (a.question?.askedAt ?? a.stepSince) - (b.question?.askedAt ?? b.stepSince)) })).filter(g => g.tasks.length), [attention]);
	return (
		<div className="view">
			<div className="inbox">
				<div className="inbox-sum">
					<div className="sum" style={tone('red')}><b>{attention.length + manualWaiting.length}</b><span>あなたの番</span></div>
					<div className="sum" style={tone('blue')}><b>{running.length}</b><span>エージェントが進めている</span></div>
					<div className="sum"><b>{tasks.filter(t => t.step === 'todo').length}</b><span>未着手</span></div>
					<div className="sum" style={tone('amber')}><b>{soon.length}</b><span>締切が近い未着手</span></div>
				</div>
				{groups.map(g => (
					<section key={g.label}>
						<h2><span className="status" style={tone(STATUS[g.status[0]].tone)}>{g.label}</span><span className="badge soft">{g.tasks.length}</span></h2>
						{g.tasks.map(t => <InboxRow key={t.id} task={t} />)}
					</section>
				))}
				{manualWaiting.length > 0 && (
					<section>
						<h2><span className="status" style={tone('red')}>フロー外の許可待ち</span><span className="badge soft">{manualWaiting.length}</span></h2>
						{manualWaiting.map(m => (
							<div key={m.id} className="irow">
								<div><div className="card-ref"><AgentTag agent={m.agent} />{m.name}　{m.branch}</div><div className="t">{m.text}</div></div>
								<div className="acts">
									<button className="btn sm primary" onClick={() => void app.call('answerManual', { sessionId: m.id, allow: true })}>許可</button>
									<button className="btn sm" onClick={() => void app.call('answerManual', { sessionId: m.id, allow: false })}>拒否</button>
								</div>
							</div>
						))}
					</section>
				)}
				{!groups.length && !manualWaiting.length && <div className="empty-big"><Icon name="inbox" /><b>あなたの番はありません</b>エージェントが進めています。質問や承認が来たらここに並びます。</div>}
				{soon.length > 0 && (
					<section>
						<h2><span className="status" style={tone('amber')}>締切が近い未着手</span><span className="badge soft">{soon.length}</span></h2>
						{soon.slice(0, 8).map(t => (
							<div key={t.id} className="irow" role="button" tabIndex={0} onClick={() => app.openTask(t.id)}>
								<div style={{ minWidth: 0 }}>
									<div className="card-ref"><Icon name="issue" size={13} />{t.issue ? `#${t.issue.number}` : 'タスク'}</div>
									<div className="t">{t.title}</div>
									<div className="chips"><DueChip due={t.due} />{t.pr && <PrChip pr={t.pr} />}{t.labels.slice(0, 3).map(l => <LabelChip key={l.name} label={l} />)}</div>
								</div>
								<div className="acts"><StartButton task={t} /></div>
							</div>
						))}
					</section>
				)}
			</div>
		</div>
	);
}

function StartButton({ task }: { task: ITaskBoardTask }) {
	const actions = useTaskActions();
	return <button className="btn sm primary" onClick={e => { e.stopPropagation(); actions.start(task); }}><Icon name="play" />着手する</button>;
}
