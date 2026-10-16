// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ITaskBoardFlow, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { useTaskActions } from '../actions.js';
import { useApp, type TabId } from '../context.js';
import { ago, desiredStage, needs, stageMismatch, STATUS, stepName } from '../format.js';
import { useNarrow, useNow, usePhone } from '../hooks.js';
import { Icon, type IconName } from '../icons.js';
import { AgentTag, Avatar, CiIcon, DueChip, Elapsed, LabelChip, Menu, PrChip, Spinner, Status, tone } from './atoms.js';
import { ArtifactsTab, IssueTab, MockTab, PlanTab, ProgressTab, PrTab, TerminalTab } from './tabs.js';

interface ITabDef {
	readonly id: TabId;
	readonly label: string;
	readonly icon: IconName;
	readonly meta?: ReactNode;
	readonly dim?: boolean;
}

export function tabsFor(task: ITaskBoardTask, flow: ITaskBoardFlow): (ITabDef | 'sep')[] {
	const s = task.status;
	const plans = task.artifacts.filter(a => a.kind === 'plan' || a.kind === 'report');
	const mocks = task.artifacts.filter(a => a.kind === 'mock');
	const shots = task.artifacts.filter(a => a.kind === 'screenshot');
	const tabs: (ITabDef | 'sep')[] = [{ id: 'issue', label: task.issue ? 'Issue' : '概要', icon: 'issue' }];
	if (task.pr) {
		const pr = task.pr;
		const chk = pr.checks === 'success' ? <span className="chk ok"><Icon name="check" size={12} />{pr.checksPassed ?? ''}{pr.checksTotal ? `/${pr.checksTotal}` : ''}</span>
			: pr.checks === 'failure' ? <span className="chk ng"><Icon name="x" size={12} />{pr.checksTotal && pr.checksPassed !== undefined ? `${pr.checksTotal - pr.checksPassed} 失敗` : '失敗'}</span>
				: pr.checks === 'pending' ? <span className="chk pend"><Spinner small t="amber" />{pr.checksPassed ?? ''}{pr.checksTotal ? `/${pr.checksTotal}` : ''}</span> : null;
		tabs.push({ id: 'pr', label: 'PR', icon: 'pr', meta: <><span className={`state ${pr.state === 'draft' ? 'draft' : pr.state === 'merged' ? 'merged' : 'open'}`}>#{pr.number}</span>{chk}</> });
	}
	tabs.push('sep');
	const index = flow.steps.findIndex(x => x.id === task.step);
	tabs.push({
		id: 'progress', label: '進捗', icon: 'progress',
		meta: s === 'question' || s === 'permission' || s === 'failed' ? <span className="need" /> : s === 'working' || s === 'preparing' ? <Spinner small /> : task.step !== 'todo' ? <span className="cnt">{task.step === 'done' ? flow.steps.length : Math.max(0, index)}/{flow.steps.length}</span> : undefined,
	});
	tabs.push({ id: 'plan', label: '計画', icon: 'plan', meta: s === 'approval' ? <span className="wait" /> : plans.length > 1 ? <span className="cnt">{plans.length}</span> : undefined, dim: !plans.length });
	tabs.push({ id: 'mock', label: 'モック', icon: 'mock', meta: mocks.length ? <span className="cnt">{mocks.length}</span> : undefined, dim: !mocks.length });
	tabs.push({ id: 'artifacts', label: '成果物', icon: 'art', meta: shots.length ? <span className="cnt">{shots.length}</span> : undefined, dim: !shots.length && !task.log.length });
	tabs.push({ id: 'terminal', label: 'ターミナル', icon: 'term', meta: task.place && (s === 'working' || s === 'question' || s === 'permission') ? <span className="live" /> : undefined, dim: !task.log.length });
	return tabs;
}

export function defaultTab(task: ITaskBoardTask): TabId {
	if (task.status === 'question' || task.status === 'permission' || task.status === 'working' || task.status === 'preparing' || task.status === 'queued' || task.status === 'stalled') {
		return 'progress';
	}
	if (task.status === 'approval') {
		return task.artifacts.some(a => a.kind === 'plan') ? 'plan' : 'progress';
	}
	if (task.status === 'failed' || task.status === 'ready' || task.status === 'waiting') {
		return task.pr ? 'pr' : 'progress';
	}
	return 'issue';
}

function Side({ task, flow }: { task: ITaskBoardTask; flow: ITaskBoardFlow }) {
	const app = useApp();
	const actions = useTaskActions();
	const narrow = useNarrow();
	const [open, setOpen] = useState(false);
	const slot = task.place ? (task.place.startsWith('manual:') ? task.place.slice(7) : app.snapshot.slots.find(s => s.id === task.place)?.name ?? task.place) : undefined;
	const content = (
		<div className="side-content">
			<div className="side-sec">
				<div className="side-h"><Icon name="person" size={13} />担当者</div>
				{task.assignees.length ? task.assignees.map(a => <div key={a} className="side-row"><Avatar name={a} src={task.avatars?.[a]} />{a}</div>) : <span className="faint">なし</span>}
			</div>
			<div className="side-sec">
				<div className="side-h"><Icon name="label" size={13} />ラベル</div>
				<div className="chips" style={{ marginTop: 0 }}>{task.labels.length ? task.labels.map(l => <LabelChip key={l.name} label={l} />) : <span className="faint">なし</span>}</div>
			</div>
			{(task.projectStatus || task.due || task.priority || task.projectItemId) && (
				<div className="side-sec">
					<div className="side-h"><Icon name="board" size={13} />{app.snapshot.github.sourceLabel?.includes('Projects') ? app.snapshot.github.sourceLabel.split('/').pop()?.trim() : 'Projects'}</div>
					<div className="kv">
						{task.projectStatus && <><span>ステータス</span><span>{task.projectStatus}</span></>}
						{flow.intake.stageField && task.projectItemId && <><span className="ellipsis" title={flow.intake.stageField}>{flow.intake.stageField}</span><span>{task.projectStage ?? 'なし'}{stageMismatch(task, flow) && <span className="chip due soon" style={{ marginLeft: 6 }}>工程は {desiredStage(task, flow)}</span>}</span></>}
						<span>締切</span><span>{task.due ? <DueChip due={task.due} /> : 'なし'}</span>
						<span>優先度</span><span>{task.priority ?? 'なし'}</span>
					</div>
				</div>
			)}
			<div className="side-sec">
				<div className="side-h"><Icon name="branch" size={13} />開発</div>
				{task.pr ? (
					<div className="side-row" style={{ cursor: 'pointer' }} onClick={() => app.setTab('pr')}>
						<Icon name={task.pr.state === 'merged' ? 'merge' : 'pr'} size={14} /><span>#{task.pr.number}</span>
						<span className={`chip pr ${task.pr.state}`} style={{ height: 18 }}>{task.pr.state === 'draft' ? 'Draft' : task.pr.state === 'merged' ? 'Merged' : task.pr.state === 'closed' ? 'Closed' : 'Open'}</span>
						{task.pr.simulated && <span className="chip sim" style={{ height: 18 }}>見本</span>}
						<span className="grow" /><CiIcon state={task.pr.checks === 'none' ? 'none' : task.pr.checks} />
					</div>
				) : <span className="faint">PR はまだありません</span>}
				{task.branch && <div className="side-row" style={{ marginTop: 8 }}><span className="branch">{task.branch}</span></div>}
			</div>
			<div className="side-sec">
				<div className="side-h"><Icon name="flow" size={13} />タスク</div>
				<div className="kv">
					<span>フロー</span><span>{flow.name}</span>
					<span>作業場所</span><span>{slot ?? (task.step === 'todo' ? 'なし' : '返却済み')}</span>
					<span>エージェント</span><span>{task.agent && task.step !== 'todo' ? <AgentTag agent={task.agent} /> : 'なし'}</span>
					{task.model && <><span>モデル</span><span className="mono">{task.model}</span></>}
					<span>この工程</span><span>{task.step === 'todo' || task.step === 'done' ? '—' : <Elapsed since={task.stepSince} />}</span>
					<span>作成</span><span>{new Date(task.createdAt).toLocaleDateString('ja-JP')}</span>
				</div>
				{task.step !== 'todo' && task.step !== 'done' && <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
					<button className="btn sm" onClick={() => actions.sendBack(task)}><Icon name="undo" />差し戻す</button>
					<button className="btn sm danger" onClick={() => actions.cancel(task)}><Icon name="stop" />中止</button>
				</div>}
			</div>
		</div>
	);
	if (!narrow) {
		return <aside className="p-side">{content}</aside>;
	}
	return (
		<aside className={`p-side ${open ? 'open' : ''}`}>
			<button className="side-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
				<Icon name="info" size={14} />タスクの情報
				<span className="sum-line">{[flow.name, slot, task.branch, task.pr ? `PR #${task.pr.number}` : ''].filter(Boolean).join('　')}</span>
				<Icon name="chevron" size={14} className="caret" />
			</button>
			{content}
		</aside>
	);
}

export function Panel() {
	const app = useApp();
	const actions = useTaskActions();
	const phone = usePhone();
	const now = useNow();
	const task = app.snapshot.tasks.find(t => t.id === app.selectedId);
	const [wide, setWide] = useState(false);
	const [keysShown, setKeysShown] = useState(false);
	const tabsRef = useRef<HTMLDivElement>(null);
	const [ink, setInk] = useState<{ left: number; width: number }>();
	const lastTask = useRef<ITaskBoardTask | undefined>(undefined);
	if (task) {
		lastTask.current = task;
	}
	const shown = task ?? lastTask.current;
	const flow = shown ? app.flowOf(shown) : undefined;
	const tabs = shown && flow ? tabsFor(shown, flow) : [];
	const ids = tabs.filter((t): t is ITabDef => t !== 'sep').map(t => t.id);
	const tab = ids.includes(app.tab) ? app.tab : 'issue';

	useLayoutEffect(() => {
		const on = tabsRef.current?.querySelector<HTMLElement>('.ptab.on');
		if (on) {
			setInk({ left: on.offsetLeft + 8, width: on.offsetWidth - 16 });
			on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		}
	}, [tab, task?.id, tabs.length, wide, task?.status, task?.pr?.checks]);

	useEffect(() => {
		if (!task) {
			return;
		}
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			if (target.closest('input, textarea, select, [contenteditable], .modal-back')) {
				return;
			}
			if (e.metaKey || e.ctrlKey || e.altKey) {
				if (e.key === 'Meta' || e.key === 'Control') {
					setKeysShown(true);
				}
				return;
			}
			if (/^[1-9]$/.test(e.key)) {
				const id = ids[Number(e.key) - 1];
				if (id) {
					e.preventDefault();
					app.setTab(id);
				}
			} else if (e.key === '[' || e.key === ']') {
				const i = ids.indexOf(tab);
				app.setTab(ids[(i + (e.key === ']' ? 1 : ids.length - 1)) % ids.length]);
			}
		};
		const onUp = () => setKeysShown(false);
		document.addEventListener('keydown', onKey);
		document.addEventListener('keyup', onUp);
		window.addEventListener('blur', onUp);
		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('keyup', onUp);
			window.removeEventListener('blur', onUp);
		};
	}, [task, ids, tab, app]);

	const open = Boolean(task);
	if (!shown || !flow) {
		return <><div className="scrim" /><aside className="panel" aria-hidden="true" /></>;
	}
	const status = STATUS[shown.status];
	const index = flow.steps.findIndex(s => s.id === shown.step);
	const repoUrl = shown.issue ? `https://github.com/${shown.issue.owner}/${shown.issue.repo}` : undefined;
	let n = 0;
	const body = (() => {
		switch (tab) {
			case 'pr': return <PrTab task={shown} />;
			case 'progress': return <ProgressTab task={shown} flow={flow} />;
			case 'plan': return <PlanTab task={shown} flow={flow} />;
			case 'mock': return <MockTab task={shown} />;
			case 'artifacts': return <ArtifactsTab task={shown} />;
			case 'terminal': return <TerminalTab task={shown} />;
			default: return <IssueTab task={shown} flow={flow} repoUrl={repoUrl} />;
		}
	})();
	return (
		<>
			<div className={`scrim ${open ? 'on' : ''}`} onClick={app.closeTask} />
			<aside className={`panel ${open ? 'on' : ''} ${wide ? 'wide' : ''}`} aria-label="タスクの詳細" aria-hidden={!open}>
				<div className="p-head">
					<div className="crumb">
						{phone && <button className="btn ghost icon sm" onClick={app.closeTask} aria-label="戻る"><Icon name="chevronLeft" /></button>}
						<span className="crumb-path" style={{ display: 'contents' }}>
							<Icon name="board" size={13} /><span>{flow.name}</span><span className="sep">/</span>
							<span className="ellipsis">{shown.issue ? `${shown.issue.owner}/${shown.issue.repo}` : 'ボードのタスク'}</span>
						</span>
						<div className="acts">
							{actions.githubUrl(shown) && <a className="btn ghost sm" href={actions.githubUrl(shown)} target="_blank" rel="noreferrer"><Icon name="ext" size={14} />GitHub</a>}
							{!phone && <button className="btn ghost icon sm" onClick={() => setWide(!wide)} title={wide ? '元の幅に戻す' : '広げる'} aria-label={wide ? '元の幅に戻す' : '広げる'}><Icon name={wide ? 'collapse' : 'expand'} size={14} /></button>}
							<Menu label="タスクの操作" items={actions.menuItems(shown)} trigger={(o, toggle) => <button className="btn ghost icon sm" aria-label="タスクの操作" aria-expanded={o} onClick={toggle}><Icon name="dots" size={14} /></button>} />
							{!phone && <button className="btn ghost icon sm" onClick={app.closeTask} title="閉じる（Esc）" aria-label="閉じる"><Icon name="close" size={14} /></button>}
						</div>
					</div>
					<div className="p-title">{shown.title} {shown.issue && <a href={shown.issue.url || undefined} target="_blank" rel="noreferrer">#{shown.issue.number}</a>}</div>
					<div className="p-meta">
						{shown.issue ? (shown.prOwned && shown.pr?.state === 'merged'
							// ボードが作った PR は本文に Closes #n を書くので、マージされたら Issue も閉じている
							? <span className="pill closed"><Icon name="check" size={14} />Closed</span>
							: <span className="pill open"><Icon name="issue" size={14} />Open</span>) : <span className="pill task">ボードのタスク</span>}
						<Status status={shown.status} />
						{shown.step !== 'todo' && shown.step !== 'done' && <span>工程: {stepName(flow, shown.step)}</span>}
						{shown.branch && shown.step !== 'todo' && <span className="branch">{shown.branch}</span>}
						{shown.agent && shown.step !== 'todo' && <AgentTag agent={shown.agent} />}
						{shown.pr && <PrChip pr={shown.pr} onClick={() => app.setTab('pr')} />}
						{shown.due && <DueChip due={shown.due} />}
					</div>
					{shown.step !== 'todo' && <>
						<div className="tracker" style={tone(status.tone)} aria-label="工程の進み具合">
							{flow.steps.map((s, i) => {
								const h = [...shown.history].reverse().find(x => x.stepId === s.id);
								const cls = shown.step === 'done' || i < index ? (h?.result === 'skipped' ? 's' : 'd') : i === index ? 'c' : '';
								return <button key={s.id} className={cls} title={`${s.name}${h ? `（${h.result === 'skipped' ? '飛ばした' : '完了'} ${ago(h.endedAt, now)}）` : ''}`} tabIndex={-1}>{s.name}</button>;
							})}
						</div>
						<div className="tracker-compact" style={tone(status.tone)}>
							<span>{shown.step === 'done' ? '完了' : `${index + 1}/${flow.steps.length} ${stepName(flow, shown.step)}`}</span>
							<span className="bar3">{flow.steps.map((s, i) => <i key={s.id} className={shown.step === 'done' || i < index ? 'd' : i === index ? 'c' : ''} />)}</span>
						</div>
					</>}
				</div>
				<nav className={`ptabs ${keysShown ? 'keys' : ''}`} role="tablist" aria-label="詳細のタブ" ref={tabsRef}>
					{tabs.map((t, i) => {
						if (t === 'sep') {
							return <span key={`sep${i}`} className="ptab-sep" />;
						}
						n++;
						return (
							<button key={t.id} role="tab" aria-selected={tab === t.id} className={`ptab ${tab === t.id ? 'on' : ''} ${t.dim ? 'dim' : ''}`} onClick={() => app.setTab(t.id)} title={`${t.label}（${n}）`}>
								<Icon name={t.icon} /><span className="lbl">{t.label}</span>{t.meta}<kbd>{n}</kbd>
							</button>
						);
					})}
					<span className="ptabs-right">{needs(shown) && <span className="status" style={tone(status.tone)}>{status.label}</span>}<span>更新 {ago(shown.updatedAt, now)}</span></span>
					{ink && <span className="ptab-ink" style={{ left: ink.left, width: ink.width }} />}
				</nav>
				<div className="p-body">
					<Side task={shown} flow={flow} />
					<div className="p-main" key={`${shown.id}:${tab}`} role="tabpanel">{body}</div>
				</div>
			</aside>
		</>
	);
}
