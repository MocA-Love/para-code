// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ITaskBoardFlow, ITaskBoardNotice, ITaskBoardSnapshot, ITaskBoardStep, ITaskBoardTask, TaskBoardErrorCode, TaskBoardStatus, TaskBoardStepKind } from '@engine/paradisTaskBoard.js';

/* 画面の文言はここに集める。 */

export type Tone = 'blue' | 'red' | 'amber' | 'green' | 'gray' | 'accent';

export const STATUS: Record<TaskBoardStatus, { label: string; tone: Tone; need?: boolean }> = {
	todo: { label: '未着手', tone: 'gray' },
	queued: { label: '空き待ち', tone: 'gray' },
	preparing: { label: '準備中', tone: 'blue' },
	working: { label: '作業中', tone: 'blue' },
	question: { label: '回答待ち', tone: 'red', need: true },
	permission: { label: '許可待ち', tone: 'red', need: true },
	approval: { label: '承認待ち', tone: 'amber', need: true },
	stalled: { label: '報告なしで停止', tone: 'amber', need: true },
	failed: { label: '失敗', tone: 'red', need: true },
	waiting: { label: '外部待ち', tone: 'gray' },
	ready: { label: 'マージ待ち', tone: 'green', need: true },
	done: { label: '完了', tone: 'green' },
};

export const KIND: Record<TaskBoardStepKind, { label: string; desc: string }> = {
	agent: { label: 'AI', desc: 'エージェントが進め、終わったらボードに報告' },
	human: { label: '人', desc: 'あなたの判断を待つ' },
	run: { label: '自動', desc: 'コマンドを実行' },
	wait: { label: '外部待ち', desc: 'GitHub の状態を見張る' },
};

export const TONE_VAR: Record<Tone, string> = {
	blue: 'var(--blue)', red: 'var(--red)', amber: 'var(--amber)', green: 'var(--green)', gray: 'var(--faint)', accent: 'var(--accent)',
};

export function needs(task: ITaskBoardTask): boolean {
	return Boolean(STATUS[task.status].need);
}

export function stepName(flow: ITaskBoardFlow | undefined, stepId: string): string {
	if (stepId === 'todo') {
		return '未着手';
	}
	if (stepId === 'done') {
		return '完了';
	}
	return flow?.steps.find(s => s.id === stepId)?.name ?? stepId;
}

export function stepDetail(step: ITaskBoardStep): string {
	if (step.kind === 'agent') {
		return step.prompt || '指示なし';
	}
	if (step.kind === 'human') {
		return step.gate === 'merge' ? 'PR をマージする（GitHub で）' : '成果物を見て承認か差し戻し';
	}
	if (step.kind === 'run') {
		return step.run === 'draft-pr' ? 'ドラフト PR を作る' : step.command || 'コマンド未設定';
	}
	return step.wait === 'checks' ? 'CI のチェックが終わるのを待つ' : 'レビュー（ボットを含む）が付くのを待つ';
}

export function completionRule(step: ITaskBoardStep): string {
	if (step.kind === 'agent') {
		return 'エージェントの board_complete_step の報告';
	}
	if (step.kind === 'human') {
		return step.gate === 'merge' ? 'PR がマージされたとき' : '承認の操作';
	}
	if (step.kind === 'run') {
		return step.run === 'draft-pr' ? 'PR ができたとき' : '終了コード 0';
	}
	return step.wait === 'checks' ? 'チェックがすべて通ったとき' : 'レビューが付いたとき（変更を求められたら失敗）';
}

export function taskActivity(task: ITaskBoardTask, flow: ITaskBoardFlow | undefined): string {
	if (task.error && (task.status === 'failed' || task.status === 'stalled')) {
		return errorText(task.error);
	}
	if (task.activity) {
		return task.activity;
	}
	const step = flow?.steps.find(s => s.id === task.step);
	switch (task.status) {
		case 'queued': return '作業場所の空きを待っています';
		case 'preparing': return '作業場所を準備しています';
		case 'working': return step ? `${step.name}をしています` : '作業しています';
		case 'stalled': return 'board_complete_step の報告がないまま止まりました';
		case 'waiting': return step?.wait === 'checks' ? 'チェックの結果を待っています' : 'レビューを待っています';
		case 'ready': return task.pr ? `PR #${task.pr.number} のマージを待っています` : 'マージを待っています';
		case 'approval': return '承認を待っています';
		default: return '';
	}
}

export function errorText(error: string): string {
	switch (error) {
		case 'restarted': return 'サーバーの再起動でエージェントとの接続が切れました';
		case 'changes-requested': return 'レビューで変更を求められました';
		case 'checks-failed': return 'チェックが失敗しました';
		case 'dirty': return '作業場所に未コミットの変更があります';
		default: return error;
	}
}

export function rpcErrorText(code: TaskBoardErrorCode | 'network', message: string): string {
	switch (code) {
		case 'network': return message === 'unauthorized' ? 'サーバーのトークンが変わりました。ターミナルの URL を開き直してください' : 'サーバーにつながりません';
		case 'step-in-use': return 'その工程にタスクがあるため、工程を消せません。先にタスクを移してください';
		case 'not-found': return '対象が見つかりません（ほかの操作で変わった可能性があります）';
		case 'invalid-state': return `今の状態ではできません（${message}）`;
		case 'github': return `GitHub: ${message}`;
		default: return message;
	}
}

export function noticeText(notice: ITaskBoardNotice, snapshot: ITaskBoardSnapshot | undefined): { title: string; body: string; tone: Tone } | undefined {
	const task = snapshot?.tasks.find(t => t.id === notice.taskId);
	const ref = task ? (task.issue ? `#${task.issue.number}` : task.title.slice(0, 24)) : '';
	const flow = snapshot?.flows.find(f => f.id === task?.flowId);
	switch (notice.kind) {
		case 'question': return { title: `${ref} が質問しています`, body: notice.detail ?? '', tone: 'red' };
		case 'permission': return { title: `${ref} が許可を求めています`, body: notice.detail ?? '', tone: 'red' };
		case 'approval': return { title: `${ref} の承認をお願いします`, body: `${stepName(flow, notice.stepId ?? '')}に着きました`, tone: 'amber' };
		case 'stalled': return { title: `${ref} が報告なしで止まりました`, body: '報告を促すか、完了扱いにしてください', tone: 'amber' };
		case 'failed': return { title: `${ref} が失敗しました`, body: errorText(notice.detail ?? ''), tone: 'red' };
		case 'ready': return { title: `${ref} はマージできます`, body: 'PR を確認してください', tone: 'green' };
		case 'started': return { title: `${ref} を始めました`, body: stepName(flow, notice.stepId ?? ''), tone: 'blue' };
		case 'queued': return { title: `${ref} を空き待ちに入れました`, body: '作業場所が空いたら自動で始めます', tone: 'gray' };
		case 'dequeued': return { title: `${ref} を始めました`, body: '空き待ちから着手しました', tone: 'blue' };
		case 'done': return { title: `${ref} が完了しました`, body: task?.title ?? '', tone: 'green' };
		case 'sentBack': return { title: `${ref} を差し戻しました`, body: notice.detail ?? stepName(flow, notice.stepId ?? ''), tone: 'amber' };
		case 'synced': {
			const [added, , removed] = (notice.detail ?? '0/0/0').split('/').map(Number);
			return { title: 'GitHub と同期しました', body: `${added} 件を足し、${removed} 件を外しました`, tone: 'gray' };
		}
		default: return undefined;
	}
}

/* ---------------- 時間 ---------------- */

export function clock(ms: number): string {
	const sec = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	if (m >= 60) {
		const h = Math.floor(m / 60);
		return h >= 48 ? `${Math.floor(h / 24)} 日` : `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	}
	return `${m}:${String(s).padStart(2, '0')}`;
}

export function duration(ms: number): string {
	const min = Math.round(ms / 60000);
	if (min < 1) {
		return `${Math.max(1, Math.round(ms / 1000))} 秒`;
	}
	if (min < 60) {
		return `${min} 分`;
	}
	return `${Math.floor(min / 60)} 時間${min % 60 ? ` ${min % 60} 分` : ''}`;
}

export function ago(at: number | string, now: number): string {
	const t = typeof at === 'string' ? Date.parse(at) : at;
	const sec = Math.round((now - t) / 1000);
	if (sec < 45) {
		return 'たった今';
	}
	if (sec < 3600) {
		return `${Math.round(sec / 60)} 分前`;
	}
	if (sec < 86400) {
		return `${Math.round(sec / 3600)} 時間前`;
	}
	if (sec < 86400 * 30) {
		return `${Math.round(sec / 86400)} 日前`;
	}
	return new Date(t).toLocaleDateString('ja-JP');
}

export function timeOfDay(at: number): string {
	return new Date(at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

/** 締切の表示と、近さ（today / soon / late）。 */
export function dueInfo(due: string | undefined, now: number): { text: string; level: 'late' | 'today' | 'soon' | 'normal' } | undefined {
	if (!due) {
		return undefined;
	}
	const [y, m, d] = due.split('-').map(Number);
	const target = new Date(y, m - 1, d).getTime();
	const today = new Date(new Date(now).toDateString()).getTime();
	const days = Math.round((target - today) / 86400000);
	const text = `${m}/${d}`;
	if (days < 0) {
		return { text: `${text}（${-days} 日超過）`, level: 'late' };
	}
	if (days === 0) {
		return { text: `${text}（今日）`, level: 'today' };
	}
	return { text, level: days <= 2 ? 'soon' : 'normal' };
}

export function number(n: number): string {
	return n.toLocaleString('en-US');
}

/** 工程に対応する、Projects の軸の欄の値（エンジンの desiredProjectStage と同じ決め方）。 */
export function desiredStage(task: ITaskBoardTask, flow: ITaskBoardFlow | undefined): string | undefined {
	if (!flow?.intake.stageField) {
		return undefined;
	}
	if (task.step === 'done') {
		return flow.intake.doneOption;
	}
	return flow.steps.find(s => s.id === task.step)?.projectOption;
}

/** GitHub 側の軸の欄の値が、ボードの工程と食い違っているか（Q353 A: ボードを正とし、警告だけ出す）。 */
export function stageMismatch(task: ITaskBoardTask, flow: ITaskBoardFlow | undefined): string | undefined {
	if (task.step === 'todo' || !task.projectItemId || !task.projectStage) {
		return undefined;
	}
	const desired = desiredStage(task, flow);
	return desired && desired !== task.projectStage ? task.projectStage : undefined;
}
