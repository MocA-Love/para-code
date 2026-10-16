// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useState } from 'react';
import type { ITaskBoardFlow, ITaskBoardProjectField, ITaskBoardStep, TaskBoardProjectColor, TaskBoardStepKind } from '@engine/paradisTaskBoard.js';
import { taskBoardSlug, taskBoardStepsFromOptions } from '@engine/paradisTaskBoardFlow.js';
import { useApp } from '../context.js';
import { completionRule, KIND } from '../format.js';
import { Icon } from '../icons.js';
import { ConfirmDialog } from './dialogs.js';

type Draft = { -readonly [K in keyof ITaskBoardFlow]: ITaskBoardFlow[K] };

function FlowChart({ flow, selected, onSelect }: { flow: ITaskBoardFlow; selected: string; onSelect: (id: string) => void }) {
	const bh = 40;
	const gap = 22;
	const x = 74;
	const bw = 210;
	const y = (i: number) => 10 + i * (bh + gap);
	const height = y(flow.steps.length) + 10;
	const palette: Record<TaskBoardStepKind, { fill: string; stroke: string }> = {
		agent: { fill: 'color-mix(in srgb, var(--blue) 12%, var(--card))', stroke: 'var(--blue)' },
		human: { fill: 'color-mix(in srgb, var(--amber) 12%, var(--card))', stroke: 'var(--amber)' },
		run: { fill: 'var(--card)', stroke: 'var(--faint)' },
		wait: { fill: 'var(--card)', stroke: 'var(--faint)' },
	};
	return (
		<svg viewBox={`0 0 400 ${height}`} role="img" aria-label="流れ図">
			<defs>
				<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" style={{ fill: 'var(--faint)' }} /></marker>
				<marker id="arrow-back" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" style={{ fill: 'var(--red)' }} /></marker>
			</defs>
			{flow.steps.map((s, i) => {
				const back = flow.steps.findIndex(t => t.id === s.onFail);
				const off = 28 + Math.abs(i - back) * 6;
				return (
					<g key={s.id} onClick={() => onSelect(s.id)} style={{ cursor: 'pointer' }}>
						<rect x={x} y={y(i)} width={bw} height={bh} rx={9} style={{ fill: palette[s.kind].fill, stroke: selected === s.id ? 'var(--accent)' : palette[s.kind].stroke, strokeWidth: selected === s.id ? 2 : 1 }} strokeDasharray={s.kind === 'wait' ? '4 3' : undefined} />
						<text x={x + bw / 2} y={y(i) + 25} textAnchor="middle" fontSize="12.5" style={{ fill: 'var(--text)' }}>{s.name.length > 16 ? `${s.name.slice(0, 15)}…` : s.name}</text>
						<text x={x - 10} y={y(i) + 25} textAnchor="end" fontSize="11" style={{ fill: 'var(--faint)' }}>{KIND[s.kind].label}</text>
						{i < flow.steps.length - 1 && <line x1={x + bw / 2} y1={y(i) + bh} x2={x + bw / 2} y2={y(i + 1) - 2} style={{ stroke: 'var(--faint)' }} markerEnd="url(#arrow)" />}
						{back >= 0 && back !== i && <path d={`M${x + bw} ${y(i) + bh / 2} C ${x + bw + off} ${y(i) + bh / 2}, ${x + bw + off} ${y(back) + bh / 2}, ${x + bw + 2} ${y(back) + bh / 2}`} fill="none" style={{ stroke: 'var(--red)' }} strokeDasharray="4 3" markerEnd="url(#arrow-back)" />}
					</g>
				);
			})}
		</svg>
	);
}

function newStep(kind: TaskBoardStepKind, existing: readonly ITaskBoardStep[]): ITaskBoardStep {
	const base = { agent: 'step', human: 'gate', run: 'run', wait: 'wait' }[kind];
	let id = base;
	for (let n = 2; existing.some(s => s.id === id); n++) {
		id = `${base}-${n}`;
	}
	const name = { agent: '新しい工程', human: '確認', run: 'コマンド', wait: '待つ' }[kind];
	if (kind === 'agent') {
		return { id, name, kind, agent: 'any', prompt: '' };
	}
	if (kind === 'human') {
		return { id, name, kind, gate: 'approve' };
	}
	if (kind === 'run') {
		return { id, name, kind, run: 'command', command: '' };
	}
	return { id, name, kind, wait: 'review' };
}

export function FlowEditor() {
	const app = useApp();
	const snapshot = app.snapshot;
	const [flowId, setFlowId] = useState(snapshot.activeFlowId);
	const source = snapshot.flows.find(f => f.id === flowId) ?? snapshot.flows[0];
	const [draft, setDraft] = useState<Draft>(() => ({ ...source }));
	const [selected, setSelected] = useState(source.steps[0]?.id ?? '');
	const [scope, setScope] = useState<'personal' | 'team'>(source.scope === 'team' ? 'team' : 'personal');
	const [drag, setDrag] = useState<{ id: string; over?: string; after?: boolean }>();
	const [saving, setSaving] = useState(false);
	const dirty = JSON.stringify({ ...draft, scope: undefined }) !== JSON.stringify({ ...source, scope: undefined });

	useEffect(() => {
		if (!dirty) {
			setDraft({ ...source });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [source]);

	const counts = useMemo(() => {
		const map = new Map<string, number>();
		for (const t of snapshot.tasks) {
			if (t.flowId === draft.id) {
				map.set(t.step, (map.get(t.step) ?? 0) + 1);
			}
		}
		return map;
	}, [snapshot.tasks, draft.id]);

	const step = draft.steps.find(s => s.id === selected) ?? draft.steps[0];
	const setSteps = (steps: ITaskBoardStep[]) => setDraft(d => ({ ...d, steps }));
	const updateStep = (patch: Partial<ITaskBoardStep>) => setSteps(draft.steps.map(s => s.id === step.id ? { ...s, ...patch } as ITaskBoardStep : s));
	const changeKind = (kind: TaskBoardStepKind) => {
		const fresh = newStep(kind, []);
		updateStep({ ...fresh, id: step.id, name: step.name, onFail: step.onFail, agent: fresh.agent, prompt: fresh.prompt, gate: fresh.gate, run: fresh.run, command: fresh.command, wait: fresh.wait });
	};
	const switchFlow = (id: string) => {
		const go = () => {
			const next = snapshot.flows.find(f => f.id === id)!;
			setFlowId(id);
			setDraft({ ...next });
			setSelected(next.steps[0]?.id ?? '');
			setScope(next.scope === 'team' ? 'team' : 'personal');
		};
		if (dirty) {
			app.showDialog(<ConfirmDialog title="変更を捨てますか" body="保存していない変更があります。" ok="捨てて切り替える" danger onOk={go} />);
		} else {
			go();
		}
	};
	const duplicate = () => {
		let name = `${draft.name} のコピー`;
		let id = taskBoardSlug(`${draft.id}-copy`);
		for (let n = 2; snapshot.flows.some(f => f.id === id); n++) {
			id = taskBoardSlug(`${draft.id}-copy-${n}`);
			name = `${draft.name} のコピー ${n}`;
		}
		setFlowId(id);
		setDraft({ ...draft, id, name, scope: 'personal' });
		setScope('personal');
	};
	const save = async () => {
		setSaving(true);
		const result = await app.call('saveFlow', { flow: { ...draft, scope }, scope }, { title: 'フローを保存しました', body: draft.name, tone: 'green' });
		setSaving(false);
		if (result) {
			app.toast({ title: '保存先', body: result.path, tone: 'gray' });
		}
	};
	const remove = () => {
		if ((counts.get(step.id) ?? 0) > 0) {
			app.toast({ title: '消せません', body: `「${step.name}」にタスクが ${counts.get(step.id)} 件あります。先に移してください`, tone: 'amber' });
			return;
		}
		if (draft.steps.length <= 1) {
			return;
		}
		const index = draft.steps.findIndex(s => s.id === step.id);
		setSteps(draft.steps.filter(s => s.id !== step.id).map(s => s.onFail === step.id ? { ...s, onFail: undefined } : s));
		setSelected(draft.steps[Math.max(0, index - 1)].id === step.id ? draft.steps[index + 1]?.id : draft.steps[Math.max(0, index - 1)].id);
	};
	const moveStep = (id: string, target: string, after: boolean) => {
		if (id === target) {
			return;
		}
		const list = draft.steps.filter(s => s.id !== id);
		const moved = draft.steps.find(s => s.id === id)!;
		const at = list.findIndex(s => s.id === target) + (after ? 1 : 0);
		list.splice(at, 0, moved);
		setSteps(list);
	};
	const nudge = (id: string, delta: number) => {
		const i = draft.steps.findIndex(s => s.id === id);
		const j = i + delta;
		if (j < 0 || j >= draft.steps.length) {
			return;
		}
		const list = [...draft.steps];
		[list[i], list[j]] = [list[j], list[i]];
		setSteps(list);
	};
	const intake = draft.intake;
	const setIntake = (patch: Partial<ITaskBoardFlow['intake']>) => setDraft(d => ({ ...d, intake: { ...d.intake, ...patch } }));
	const setWorkspace = (patch: Partial<ITaskBoardFlow['workspace']>) => setDraft(d => ({ ...d, workspace: { ...d.workspace, ...patch } }));
	const clones = snapshot.slots.filter(s => s.kind === 'clone-pool');

	/* ---------------- Projects の軸の欄 ---------------- */
	const [fields, setFields] = useState<readonly ITaskBoardProjectField[]>();
	const [loadingFields, setLoadingFields] = useState(false);
	const projectOwner = intake.owner ?? snapshot.runtime.repoLabel?.split('/')[0];
	const stage = fields?.find(f => f.name === intake.stageField);
	const loadFields = async () => {
		if (!projectOwner || !intake.project) {
			app.toast({ title: '読めません', body: 'オーナーと Projects の番号を入れてください', tone: 'amber' });
			return;
		}
		setLoadingFields(true);
		const result = await app.call('projectFields', { owner: projectOwner, project: intake.project });
		setLoadingFields(false);
		if (result) {
			setFields(result);
			if (!intake.stageField) {
				const guess = result.find(f => /status \(ai\)|stage|工程/i.test(f.name));
				if (guess) {
					setIntake({ stageField: guess.name });
				}
			}
		}
	};
	const importSteps = () => {
		if (!stage) {
			return;
		}
		const built = taskBoardStepsFromOptions(stage.options);
		const occupied = draft.steps.filter(s => (counts.get(s.id) ?? 0) > 0 && !built.steps.some(b => b.id === s.id));
		app.showDialog(<ConfirmDialog
			title={`「${stage.name}」から工程を作りますか`}
			body={<>
				<p style={{ marginTop: 0 }}>今の工程を、欄の選択肢 {stage.options.length} 個から作った {built.steps.length} 工程に置き換えます（保存するまで反映しません）。種類は名前と説明から推測しているので、作った後に見直してください。</p>
				{built.doneOption && <p>「{built.doneOption}」は完了に当てます。</p>}
				{occupied.length > 0 && <p style={{ color: 'var(--amber)' }}>タスクがいる工程（{occupied.map(s => s.name).join('、')}）が無くなるので、このままでは保存できません。先にタスクを移してください。</p>}
			</>}
			ok="置き換える"
			onOk={() => {
				setSteps(built.steps);
				setSelected(built.steps[0]?.id ?? '');
				setIntake({ doneOption: built.doneOption ?? intake.doneOption });
			}}
		/>);
	};
	const exportOptions = () => {
		const fieldName = intake.stageField || 'Status (Para Code)';
		const color: Record<TaskBoardStepKind, TaskBoardProjectColor> = { agent: 'BLUE', human: 'YELLOW', run: 'PURPLE', wait: 'ORANGE' };
		const have = new Set((stage?.options ?? []).map(o => o.name.toLowerCase()));
		const wanted = [...draft.steps.map(st => ({ name: st.projectOption || st.name, color: color[st.kind], description: completionRule(st) })), { name: intake.doneOption || 'Done', color: 'GREEN' as const, description: '一連の作業が終わった' }];
		const fresh = wanted.filter((o, i) => !have.has(o.name.toLowerCase()) && wanted.findIndex(w => w.name === o.name) === i);
		if (!projectOwner || !intake.project) {
			app.toast({ title: '書けません', body: 'オーナーと Projects の番号を入れてください', tone: 'amber' });
			return;
		}
		if (!fresh.length) {
			app.toast({ title: '足す選択肢はありません', body: `「${fieldName}」にすべてあります`, tone: 'gray' });
			return;
		}
		app.showDialog(<ConfirmDialog
			title={`GitHub の Projects に選択肢を足しますか`}
			body={<>
				<p style={{ marginTop: 0 }}>{projectOwner} の Projects #{intake.project} の欄「{fieldName}」{stage ? '' : '（無いので新しく作る）'}に、次の {fresh.length} 個を足します。既存の選択肢と、各項目に入っている値はそのまま残ります。</p>
				<div className="chips">{fresh.map(o => <span key={o.name} className="chip">{o.name}</span>)}</div>
			</>}
			ok="GitHub に足す"
			onOk={async () => {
				const result = await app.call('addProjectOptions', { owner: projectOwner, project: intake.project!, fieldName, options: fresh }, { title: 'Projects に選択肢を足しました', body: fresh.map(o => o.name).join('、'), tone: 'green' });
				if (result) {
					setIntake({ stageField: fieldName, doneOption: intake.doneOption || 'Done' });
					setSteps(draft.steps.map(st => st.projectOption ? st : { ...st, projectOption: st.name }));
					void loadFields();
				}
			}}
		/>);
	};

	return (
		<div className="view">
			<div className="flow">
				<section>
					<div className="sec-title">フロー<span className="grow" />{dirty && <span className="dirty-note"><Icon name="info" size={13} />保存していない変更</span>}</div>
					<div className="form">
						<label htmlFor="flow-pick">編集するフロー</label>
						<div style={{ display: 'flex', gap: 6 }}>
							<select id="flow-pick" className="input" value={flowId} onChange={e => switchFlow(e.target.value)}>
								{snapshot.flows.map(f => <option key={f.id} value={f.id}>{f.name}（{f.scope === 'builtin' ? '組み込み' : f.scope === 'team' ? '共通' : '個人'}）</option>)}
								{!snapshot.flows.some(f => f.id === flowId) && <option value={flowId}>{draft.name}（新規）</option>}
							</select>
							<button className="btn icon" title="複製して新しいフローにする" onClick={duplicate}><Icon name="plus" /></button>
						</div>
						<label htmlFor="flow-name">名前</label>
						<input id="flow-name" className="input" value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
					</div>
					<div className="sec-title">取り込み元</div>
					<div className="form">
						<label>種類</label>
						<div className="seg">
							{([['github-issues', 'Issue'], ['github-project', 'Projects'], ['none', 'なし']] as const).map(([v, l]) => <button key={v} className={intake.source === v ? 'on' : ''} onClick={() => setIntake({ source: v })}>{l}</button>)}
						</div>
						{intake.source !== 'none' && <>
							<label htmlFor="in-owner">オーナー</label>
							<input id="in-owner" className="input" value={intake.owner ?? ''} placeholder={snapshot.runtime.repoLabel?.split('/')[0] ?? 'owner'} onChange={e => setIntake({ owner: e.target.value || undefined })} />
						</>}
						{intake.source === 'github-issues' && <>
							<label htmlFor="in-repo">リポジトリ</label>
							<input id="in-repo" className="input" value={intake.repo ?? ''} placeholder={snapshot.runtime.repoLabel?.split('/')[1] ?? 'repo'} onChange={e => setIntake({ repo: e.target.value || undefined })} />
							<span className="hint">空なら起動したリポジトリ。担当が自分の、開いている Issue を取り込みます</span>
						</>}
						{intake.source === 'github-project' && <>
							<label htmlFor="in-proj">番号</label>
							<input id="in-proj" className="input" type="number" min={1} value={intake.project ?? ''} onChange={e => setIntake({ project: Number(e.target.value) || undefined })} />
							<label htmlFor="in-status">ステータス欄</label>
							<input id="in-status" className="input" value={intake.statusField ?? ''} placeholder="Status" onChange={e => setIntake({ statusField: e.target.value || undefined })} />
							<label htmlFor="in-todo">未着手の値</label>
							<input id="in-todo" className="input" value={(intake.todoValues ?? []).join(', ')} placeholder="Todo" onChange={e => setIntake({ todoValues: e.target.value.split(',').map(v => v.trim()).filter(Boolean) })} />
							<label htmlFor="in-due">締切の欄</label>
							<input id="in-due" className="input" value={intake.dueField ?? ''} placeholder="最初の日付の欄" onChange={e => setIntake({ dueField: e.target.value || undefined })} />
							<label htmlFor="in-pri">優先度の欄</label>
							<input id="in-pri" className="input" value={intake.priorityField ?? ''} placeholder="Priority" onChange={e => setIntake({ priorityField: e.target.value || undefined })} />
							<label htmlFor="in-stage">軸の欄</label>
							<div style={{ display: 'flex', gap: 6 }}>
								{fields ? (
									<select id="in-stage" className="input" value={intake.stageField ?? ''} onChange={e => setIntake({ stageField: e.target.value || undefined })}>
										<option value="">使わない</option>
										{fields.map(f => <option key={f.id} value={f.name}>{f.name}（{f.options.length}）</option>)}
										{intake.stageField && !fields.some(f => f.name === intake.stageField) && <option value={intake.stageField}>{intake.stageField}（未作成）</option>}
									</select>
								) : (
									<input id="in-stage" className="input" value={intake.stageField ?? ''} placeholder="Status (AI)" onChange={e => setIntake({ stageField: e.target.value || undefined })} />
								)}
								<button className="btn" onClick={() => void loadFields()} disabled={loadingFields || snapshot.github.mode !== 'ok'} title="Projects の単一選択の欄を読む">{loadingFields ? '読んでいます' : '欄を読む'}</button>
							</div>
							<span className="hint">工程の列と対応させる欄。工程が進むと、この欄の値を書き戻します</span>
							{intake.stageField && <>
								<label htmlFor="in-done">完了の値</label>
								{stage ? (
									<select id="in-done" className="input" value={intake.doneOption ?? ''} onChange={e => setIntake({ doneOption: e.target.value || undefined })}>
										<option value="">書き戻さない</option>
										{stage.options.map(o => <option key={o.id} value={o.name}>{o.name}</option>)}
									</select>
								) : <input id="in-done" className="input" value={intake.doneOption ?? ''} placeholder="Done" onChange={e => setIntake({ doneOption: e.target.value || undefined })} />}
								<label>書き戻し</label>
								<label className="toggle"><input type="checkbox" checked={intake.writeBack !== false} onChange={e => setIntake({ writeBack: e.target.checked ? undefined : false })} />工程が進んだら GitHub の欄も変える</label>
								<label />
								<div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
									<button className="btn sm" disabled={!stage} onClick={importSteps} title={stage ? '' : '先に「欄を読む」を押してください'}><Icon name="flow" size={13} />この欄から工程を作る</button>
									<button className="btn sm" disabled={snapshot.github.mode !== 'ok'} onClick={exportOptions}><Icon name="plus" size={13} />工程を Projects の欄に足す</button>
								</div>
							</>}
						</>}
					</div>
					<div className="sec-title">作業場所</div>
					<div className="form">
						<label>方式</label>
						<div className="seg">
							<button className={draft.workspace.kind === 'clone-pool' ? 'on' : ''} onClick={() => setWorkspace({ kind: 'clone-pool' })}>クローンを使い回す</button>
							<button className={draft.workspace.kind === 'worktree' ? 'on' : ''} onClick={() => setWorkspace({ kind: 'worktree' })}>ワークツリー</button>
						</div>
						{draft.workspace.kind === 'clone-pool' && <>
							<label>クローン</label>
							<span className="muted" style={{ fontSize: 12 }}>{clones.length ? clones.map(c => c.name).join('、') : '未設定'}</span>
							<span className="hint">クローンの場所は人ごとに違うので、リポジトリには書かず個人の設定（起動時の --clones）に置きます</span>
						</>}
						<label>返すとき</label>
						<div className="seg">
							<button className={draft.workspace.releaseOn === 'pr-opened' ? 'on' : ''} onClick={() => setWorkspace({ releaseOn: 'pr-opened' })}>PR を出したとき</button>
							<button className={draft.workspace.releaseOn === 'merged' ? 'on' : ''} onClick={() => setWorkspace({ releaseOn: 'merged' })}>完了したとき</button>
						</div>
						<label>コミット</label>
						<div>
							<div className="seg">
								{([['ask', '人に聞く'], ['agent', 'エージェントに任せる'], ['board', 'ボードが自動で']] as const).map(([v, l]) => <button key={v} className={(draft.workspace.commit ?? 'ask') === v ? 'on' : ''} onClick={() => setWorkspace({ commit: v })}>{l}</button>)}
							</div>
							<span className="hint">{{ ask: 'PR を作る前に未コミットの変更があれば、コミットするかをあなたに聞きます', agent: 'エージェントへの指示に「タスクのブランチにコミットして（push はしない）」を書き足します', board: 'PR を作る前に、残った変更をボードがまとめてコミットします' }[draft.workspace.commit ?? 'ask']}。push と PR の作成は「ドラフト PR」の工程が行います</span>
						</div>
						<label htmlFor="ws-max">同時に動かす</label>
						<input id="ws-max" className="input" type="number" min={1} max={12} value={draft.workspace.maxRunning} onChange={e => setWorkspace({ maxRunning: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })} style={{ width: 90 }} />
					</div>
					<div className="sec-title">工程<span className="faint" style={{ fontWeight: 400 }}>ドラッグか ↑↓ で並べ替え</span></div>
					<div className="steplist" role="listbox" aria-label="工程">
						{draft.steps.map((s, i) => (
							<button
								key={s.id}
								role="option"
								aria-selected={s.id === step.id}
								className={`stepitem ${s.id === step.id ? 'sel' : ''} ${drag?.over === s.id ? (drag.after ? 'over-bottom' : 'over-top') : ''}`}
								draggable
								onClick={() => setSelected(s.id)}
								onKeyDown={e => { if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); nudge(s.id, e.key === 'ArrowUp' ? -1 : 1); } }}
								onDragStart={e => { e.dataTransfer.setData('text/x-step', s.id); setDrag({ id: s.id }); }}
								onDragOver={e => { if (drag) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setDrag({ ...drag, over: s.id, after: e.clientY > r.top + r.height / 2 }); } }}
								onDrop={e => { e.preventDefault(); if (drag) { moveStep(drag.id, s.id, Boolean(drag.after)); } setDrag(undefined); }}
								onDragEnd={() => setDrag(undefined)}
							>
								<span className="grip"><Icon name="grip" size={14} /></span>
								<span className="stepno num">{i + 1}</span>
								<span className="ellipsis">{s.name}</span>
								{(counts.get(s.id) ?? 0) > 0 ? <span className="cnt" title="この工程のタスク">{counts.get(s.id)}</span> : <span />}
								<span className={`kind ${s.kind === 'human' ? 'human' : ''}`}>{KIND[s.kind].label}</span>
							</button>
						))}
					</div>
					<div className="flow-foot">
						<button className="btn sm" onClick={() => { const s = newStep('agent', draft.steps); const at = draft.steps.findIndex(x => x.id === step.id) + 1; const list = [...draft.steps]; list.splice(at, 0, s); setSteps(list); setSelected(s.id); }}><Icon name="plus" />工程を足す</button>
						<span className="grow" />
						<button className="btn sm ghost" onClick={() => nudge(step.id, -1)} aria-label="上へ"><Icon name="chevron" className="flip" /></button>
						<button className="btn sm ghost" onClick={() => nudge(step.id, 1)} aria-label="下へ"><Icon name="chevron" /></button>
					</div>
				</section>
				<section>
					<div className="sec-title">工程の設定</div>
					{step && (
						<div className="form">
							<label htmlFor="st-name">名前</label>
							<input id="st-name" className="input" value={step.name} onChange={e => updateStep({ name: e.target.value })} />
							<label>種類</label>
							<div className="seg">{(Object.keys(KIND) as TaskBoardStepKind[]).map(k => <button key={k} className={step.kind === k ? 'on' : ''} onClick={() => changeKind(k)}>{KIND[k].label}</button>)}</div>
							{step.kind === 'agent' && <>
								<label>担当</label>
								<div className="seg">{([['any', 'どれでも'], ['claude', 'Claude Code'], ['codex', 'Codex']] as const).map(([v, l]) => <button key={v} className={(step.agent ?? 'any') === v ? 'on' : ''} onClick={() => updateStep({ agent: v })}>{l}</button>)}</div>
								<label htmlFor="st-prompt">指示</label>
								<textarea id="st-prompt" className="input" rows={5} value={step.prompt ?? ''} onChange={e => updateStep({ prompt: e.target.value })} placeholder="{issue} は Issue の番号とタイトルに置き換わります" />
								<span className="hint">末尾に「終わったら board_complete_step で報告」が自動で付きます</span>
							</>}
							{step.kind === 'human' && <>
								<label>種類</label>
								<div className="seg">
									<button className={step.gate !== 'merge' ? 'on' : ''} onClick={() => updateStep({ gate: 'approve' })}>承認</button>
									<button className={step.gate === 'merge' ? 'on' : ''} onClick={() => updateStep({ gate: 'merge' })}>マージ</button>
								</div>
								<label htmlFor="st-desc">説明</label>
								<textarea id="st-desc" className="input" rows={3} value={step.prompt ?? ''} onChange={e => updateStep({ prompt: e.target.value })} placeholder="何を見て判断するか（任意）" />
							</>}
							{step.kind === 'run' && <>
								<label>中身</label>
								<div className="seg">
									<button className={step.run === 'draft-pr' ? 'on' : ''} onClick={() => updateStep({ run: 'draft-pr', command: undefined })}>ドラフト PR</button>
									<button className={step.run !== 'draft-pr' ? 'on' : ''} onClick={() => updateStep({ run: 'command' })}>コマンド</button>
								</div>
								{step.run !== 'draft-pr' && <>
									<label htmlFor="st-cmd">コマンド</label>
									<input id="st-cmd" className="input mono" value={step.command ?? ''} onChange={e => updateStep({ command: e.target.value })} placeholder="scripts/test-integration.sh" />
								</>}
							</>}
							{step.kind === 'wait' && <>
								<label>待つもの</label>
								<div className="seg">
									<button className={step.wait !== 'checks' ? 'on' : ''} onClick={() => updateStep({ wait: 'review' })}>レビュー</button>
									<button className={step.wait === 'checks' ? 'on' : ''} onClick={() => updateStep({ wait: 'checks' })}>チェック</button>
								</div>
							</>}
							{intake.stageField && <>
								<label htmlFor="st-opt">{intake.stageField} の値</label>
								{stage ? (
									<select id="st-opt" className="input" value={step.projectOption ?? ''} onChange={e => updateStep({ projectOption: e.target.value || undefined })}>
										<option value="">対応させない</option>
										{stage.options.map(o => <option key={o.id} value={o.name}>{o.name}</option>)}
									</select>
								) : <input id="st-opt" className="input" value={step.projectOption ?? ''} placeholder={step.name} onChange={e => updateStep({ projectOption: e.target.value || undefined })} />}
							</>}
							<label>完了の判定</label>
							<span className="muted" style={{ fontSize: 12.5 }}>{completionRule(step)}</span>
							<label htmlFor="st-fail">差し戻し先</label>
							<select id="st-fail" className="input" value={step.onFail ?? ''} onChange={e => updateStep({ onFail: e.target.value || undefined })}>
								<option value="">なし（人に知らせる）</option>
								{draft.steps.filter(s => s.id !== step.id).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
							</select>
							<label>id</label>
							<span className="mono faint">{step.id}</span>
						</div>
					)}
					<button className="btn sm danger" onClick={remove} disabled={draft.steps.length <= 1}><Icon name="trash" />この工程を消す</button>
					<div className="sec-title" style={{ marginTop: 24 }}>保存</div>
					<div className="form">
						<label>保存先</label>
						<div className="seg">
							<button className={scope === 'personal' ? 'on' : ''} onClick={() => setScope('personal')}>個人</button>
							<button className={scope === 'team' ? 'on' : ''} onClick={() => setScope('team')}>チーム共通</button>
						</div>
					</div>
					<div className="path">{scope === 'personal' ? `.para-code/${snapshot.github.login ?? '<GitHub のユーザー名>'}/workflows.json` : '.para-code/paracode.json'}</div>
					<div className="flow-foot">
						<button className="btn primary" disabled={!dirty && draft.scope === scope || saving || !snapshot.runtime.repoPath} onClick={save}>{saving ? '保存しています…' : '保存'}</button>
						<button className="btn" disabled={!dirty} onClick={() => setDraft({ ...source })}>元に戻す</button>
						{snapshot.activeFlowId !== draft.id && snapshot.flows.some(f => f.id === draft.id) && <button className="btn ghost" onClick={() => void app.call('setActiveFlow', { flowId: draft.id }, { title: '使うフローを切り替えました', body: draft.name, tone: 'blue' })}>このフローを使う</button>}
					</div>
					{!snapshot.runtime.repoPath && <p className="problems">リポジトリを指定せずに起動しているため保存できません（--repo）。</p>}
				</section>
				<section className="flow-chart">
					<div className="sec-title">流れ図<span className="faint" style={{ fontWeight: 400 }}>赤い点線は差し戻し</span></div>
					<FlowChart flow={draft} selected={step?.id ?? ''} onSelect={setSelected} />
				</section>
			</div>
		</div>
	);
}
