// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { formatMonitorClock } from '../../agentMonitors.js';
import { parseAgentAdvisorInfo, type AgentActivityAdvisor, type AgentAdvisorInfo, type AgentChatMessage, type AgentLiveState } from '../../store.js';

/**
 * Claude Code の Advisor（API のサーバー側ツール。エージェントが作業の途中で上位のモデルに会話全体を見せて
 * 助言をもらう）の見せ方の純ロジック。PC は transcript の `server_tool_use`（name:"advisor"）を `tool:'Advisor'` の
 * tool_use、`advisor_tool_result` を tool_result にして `advisor` の印を付けて送る。生成中は `live.tool` が
 * `'Advisor'`、`live.detail` がモデル名になる。Codex など Advisor の無い CLI では何も届かないので何も出ない。
 */

/** PC が Advisor の呼び出しに付けるツール名（`PARADIS_ADVISOR_TOOL`）。 */
export const ADVISOR_TOOL = 'Advisor';

/** 暗号化された返答の説明（決定 S1）。 */
export const ADVISOR_REDACTED_NOTE = '返答は暗号化されているため、表示できません。';

/**
 * 呼び出しの行が届いてから、一覧（activity）に相談が載るか結果が届くまでの間。この間は結果が無くても
 * 「返答なし」と言わず相談中とみなす（読み直しは hook の 350ms 後と 60 秒ごと）。
 */
export const ADVISOR_PENDING_GRACE_MS = 90_000;

/** 何を聞いたかの説明（Advisor には質問文が無い）。 */
export const ADVISOR_INPUT_NOTE = 'Advisor には質問文がありません。この時点までの会話全体が渡されます。';

/** Advisor の呼び出し・結果のメッセージなら、その印（届いた値は検証して読む）。 */
export function advisorInfoOf(message: AgentChatMessage): AgentAdvisorInfo | undefined {
	if (message.kind !== 'tool_use' && message.kind !== 'tool_result') {
		return undefined;
	}
	if (message.kind === 'tool_use' && message.tool !== ADVISOR_TOOL) {
		return undefined;
	}
	return parseAgentAdvisorInfo(message.advisor);
}

/** 生成中の表示が Advisor を待っているところか。 */
export function isAdvisorLive(live: AgentLiveState | undefined): boolean {
	return live?.phase === 'tool' && live.tool === ADVISOR_TOOL;
}

/**
 * モデル名の短い呼び名（`claude-opus-4-7` → `Opus 4.7`、`claude-sonnet-5-5-20260101` → `Sonnet 5.5`）。
 * 読めない形はそのまま返し、無ければ undefined。
 */
export function advisorModelLabel(model: string | undefined): string | undefined {
	if (model === undefined || model.length === 0) {
		return undefined;
	}
	const parts = model.replace(/^claude-/i, '').split('-').filter(part => !/^\d{8}$/.test(part));
	const [family, ...rest] = parts;
	if (family === undefined || !/^[a-z]+$/i.test(family) || !rest.every(part => /^\d+$/.test(part))) {
		return model;
	}
	const name = family.charAt(0).toUpperCase() + family.slice(1).toLowerCase();
	return rest.length > 0 ? `${name} ${rest.join('.')}` : name;
}

/** 生成中の表示の段階（「Advisor（Opus 5.5）に相談中」）。 */
export function advisorLiveLabel(live: AgentLiveState | undefined): string {
	const label = advisorModelLabel(live?.detail);
	return label !== undefined ? `Advisor（${label}）に相談中` : 'Advisor に相談中';
}

export type AdvisorStatus = AgentActivityAdvisor['status'];

export function advisorStatusLabel(status: AdvisorStatus): string {
	switch (status) {
		case 'running': return '相談中';
		case 'completed': return 'レビュー済み';
		case 'failed': return '失敗';
		case 'interrupted': return '中断';
	}
}

/** 所要時間（「14秒」「1分32秒」）。 */
export function formatAdvisorDuration(startedAt: number, endAt: number): string {
	const seconds = Math.max(0, Math.round((endAt - startedAt) / 1000));
	return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

/** サブエージェントの画面の行の 2 段目（「Opus 5.5 · 14秒 · 10:42」。相談中は「10:42〜」、失敗は error_code を添える）。 */
export function advisorListMeta(advisor: AgentActivityAdvisor, now: number): string {
	const running = advisor.status === 'running';
	return [
		advisorModelLabel(advisor.model),
		formatAdvisorDuration(advisor.startedAt, running ? now : advisor.updatedAt),
		`${formatMonitorClock(advisor.startedAt)}${running ? '〜' : ''}`,
		advisor.status === 'failed' ? advisor.errorCode ?? 'unknown_error' : undefined,
	].filter(Boolean).join(' · ');
}

/** 行の 1 段目（「Advisor · Opus 5.5」）。 */
export function advisorTitle(model: string | undefined): string {
	const label = advisorModelLabel(model);
	return label !== undefined ? `Advisor · ${label}` : 'Advisor';
}

/** 会話の 1 行（呼び出しと、届いていれば結果）。 */
export interface AdvisorCall {
	readonly id: string | undefined;
	readonly model: string | undefined;
	readonly status: AdvisorStatus;
	readonly outcome: AgentAdvisorInfo['outcome'];
	readonly errorCode: string | undefined;
	readonly startedAt: number | undefined;
	readonly endedAt: number | undefined;
}

/**
 * 会話の行の呼び出しと結果から状態を決める。結果が無いときは、一覧（activity）の状態を正本にし、一覧に無ければ
 * 生成中の表示が Advisor のとき・呼び出しから {@link ADVISOR_PENDING_GRACE_MS} 以内なら相談中、それ以外は
 * 中断（返答が来ないまま先へ進んだ）とみなす。モデル名が行に無ければ一覧の値で補う（mod の行には無いことがある）。
 */
export function describeAdvisorCall(
	use: AgentChatMessage | undefined,
	result: AgentChatMessage | undefined,
	listed: Pick<AgentActivityAdvisor, 'status' | 'model'> | undefined,
	liveAdvisor: boolean,
	now: number,
): AdvisorCall {
	const useInfo = use !== undefined ? advisorInfoOf(use) : undefined;
	const resultInfo = result !== undefined ? advisorInfoOf(result) : undefined;
	const outcome = resultInfo !== undefined ? resultInfo.outcome ?? 'redacted' : undefined;
	const recent = use?.ts !== undefined && now - use.ts < ADVISOR_PENDING_GRACE_MS;
	const status: AdvisorStatus = resultInfo !== undefined
		? (outcome === 'error' ? 'failed' : 'completed')
		: listed?.status ?? (liveAdvisor || recent ? 'running' : 'interrupted');
	return {
		id: use?.toolUseId ?? result?.toolUseId,
		model: resultInfo?.model ?? useInfo?.model ?? listed?.model,
		status, outcome,
		errorCode: resultInfo?.errorCode,
		startedAt: use?.ts,
		endedAt: result?.ts,
	};
}

/** 会話の行の右に出す要約（モックの `.targ`）。 */
export function advisorCallSummary(call: AdvisorCall, now: number): string {
	const model = advisorModelLabel(call.model);
	const duration = call.startedAt !== undefined
		? formatAdvisorDuration(call.startedAt, call.status === 'running' ? now : call.endedAt ?? call.startedAt)
		: undefined;
	switch (call.status) {
		case 'running':
			return [model !== undefined ? `${model} に相談中` : '相談中', duration].filter(Boolean).join(' · ');
		case 'failed':
			return [call.errorCode ?? 'unknown_error', model, call.endedAt !== undefined ? duration : undefined].filter(Boolean).join(' · ');
		case 'interrupted':
			return ['返答なし', model].filter(Boolean).join(' · ');
		case 'completed':
			return ['会話をレビューしました', model, call.endedAt !== undefined ? duration : undefined].filter(Boolean).join(' · ');
	}
}
