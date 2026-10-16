// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo } from 'react';
import type { ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { useApp } from '../context.js';
import { needs, stepName } from '../format.js';
import { useStored } from '../hooks.js';
import { Icon } from '../icons.js';
import { AgentTag, DueChip, Elapsed, LabelChip, PrChip, Status } from './atoms.js';
import { Card } from './Board.js';

type SortKey = 'due' | 'step' | 'status' | 'updated' | 'title';

export function ListView() {
	const app = useApp();
	const [sort, setSort] = useStored<{ key: SortKey; desc: boolean }>('listSort', { key: 'status', desc: false });
	const rows = useMemo(() => {
		const list = app.snapshot.tasks.filter(t => app.matches(t));
		const pos = (t: ITaskBoardTask) => {
			const flow = app.flowOf(t);
			return t.step === 'todo' ? -1 : t.step === 'done' ? 99 : flow.steps.findIndex(s => s.id === t.step);
		};
		const cmp: Record<SortKey, (a: ITaskBoardTask, b: ITaskBoardTask) => number> = {
			due: (a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'),
			step: (a, b) => pos(a) - pos(b),
			status: (a, b) => Number(needs(b)) - Number(needs(a)) || pos(b) - pos(a),
			updated: (a, b) => b.updatedAt - a.updatedAt,
			title: (a, b) => a.title.localeCompare(b.title, 'ja'),
		};
		list.sort(cmp[sort.key]);
		return sort.desc ? list.reverse() : list;
	}, [app, sort]);
	const head = (key: SortKey, label: string) => (
		<th className={sort.key === key ? 'on' : ''} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : undefined}>
			<button onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : false })}>{label}{sort.key === key && <Icon name="chevron" size={12} className={sort.desc ? '' : 'flip'} />}</button>
		</th>
	);
	if (!rows.length) {
		return <div className="view"><div className="empty-big"><Icon name="list" /><b>タスクはありません</b>絞り込みを外すか、タスクを追加してください</div></div>;
	}
	return (
		<div className="view">
			<table className="table">
				<thead><tr><th style={{ width: 70 }}>#</th>{head('title', 'タイトル')}{head('step', '工程')}{head('status', '状態')}<th>担当</th><th>作業場所</th><th>PR</th>{head('due', '締切')}{head('updated', '経過')}</tr></thead>
				<tbody>
					{rows.map(t => {
						const flow = app.flowOf(t);
						const place = t.place ? (t.place.startsWith('manual:') ? t.place.slice(7) : app.snapshot.slots.find(s => s.id === t.place)?.name) : '';
						return (
							<tr key={t.id} className={`r ${app.selectedId === t.id ? 'sel' : ''}`} onClick={() => app.openTask(t.id)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') { app.openTask(t.id); } }}>
								<td className="faint num">{t.issue ? t.issue.number : '—'}</td>
								<td className="title">{t.title}<div className="chips" style={{ marginTop: 4 }}>{t.labels.slice(0, 3).map(l => <LabelChip key={l.name} label={l} />)}</div></td>
								<td>{stepName(flow, t.step)}</td>
								<td><Status status={t.status} /></td>
								<td>{t.step !== 'todo' && <AgentTag agent={t.agent} short />}</td>
								<td className="muted">{place}</td>
								<td>{t.pr && <PrChip pr={t.pr} />}</td>
								<td><DueChip due={t.due} /></td>
								<td className="muted">{t.step !== 'todo' && t.step !== 'done' && <Elapsed since={t.stepSince} />}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			<div className="cards-list">
				<div className="seg" style={{ alignSelf: 'flex-start' }}>
					{([['status', '状態'], ['due', '締切'], ['step', '工程'], ['updated', '更新']] as const).map(([k, l]) => <button key={k} className={sort.key === k ? 'on' : ''} onClick={() => setSort({ key: k, desc: false })}>{l}</button>)}
				</div>
				{rows.map(t => <Card key={t.id} task={t} flow={app.flowOf(t)} selected={app.selectedId === t.id} />)}
			</div>
		</div>
	);
}
