// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 終わった会話をスマホから開き直して続きを頼む（Orca W2-29、Q121 案 A）の、画面に依らない部分。
 *
 * - 過去の会話の一覧・中身・再開は、PC（`agent.resume.v1` を広告する版）の scm チャネルの `agentSessions` /
 *   `agentSessionPreview` / `agentSessionResume` で行う。宛先は会話の指紋（`key`）で、セッション ID は PC の外へ出ない
 * - PC に届かない間の送信は、この端末に PC ごとに暗号化して最大 24 時間預かる（{@link AgentSendQueueItem}）。
 *   つながったら、開いているターミナル宛てはそのまま送り、ターミナルが閉じていたら「再開して送る」を利用者に
 *   確かめてから送る（黙って再開しない）。過去の会話宛ては、つながっても必ず確かめる
 *
 * 副作用の無い関数だけを置く。
 */

/** capability の名前（PC の `PARADIS_AGENT_RESUME_CAPABILITY` と同じ）。 */
export const AGENT_RESUME_CAPABILITY = 'agent.resume.v1';
/** 預かった送信の期限（Q121）。 */
export const AGENT_SEND_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
/** 1 台の PC に預かる送信の上限（古いものから捨てる）。 */
export const AGENT_SEND_QUEUE_LIMIT = 50;
/** 続きの依頼の長さの上限（PC の PARADIS_AGENT_RESUME_PROMPT_LIMIT と同じ）。 */
export const AGENT_RESUME_PROMPT_LIMIT = 20_000;

/** 過去の会話 1 件（PC の `agentSessions` の 1 件）。 */
export interface AgentPastSession {
	readonly key: string;
	readonly agent: 'claude' | 'codex';
	readonly title: string;
	readonly preview?: string;
	readonly previewRole?: 'user' | 'assistant';
	readonly updatedAt: number;
	readonly createdAt?: number;
	readonly branch?: string;
	/** PC で今この会話を開いているターミナル。あれば再開せずにそのタブを開く。 */
	readonly terminalKey?: string;
}

export interface AgentPastSessionPage {
	readonly sessions: readonly AgentPastSession[];
	readonly total: number;
	readonly nextOffset?: number;
}

export interface AgentPastSessionMessage {
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly ts?: number;
}

export interface AgentPastSessionPreview {
	readonly session: AgentPastSession;
	readonly messages: readonly AgentPastSessionMessage[];
	readonly truncated: boolean;
}

/** 再開の結果。`running` は PC で既に開いていた（そのタブを開く）。`needs-trust` は PC でフォルダの信頼の確認が出ている。 */
export interface AgentResumeResult {
	readonly status: 'resumed' | 'running' | 'needs-trust' | 'duplicate';
	readonly terminalKey?: string;
	/** 依頼をエージェントへ渡せたか。 */
	readonly delivered?: boolean;
	readonly message?: string;
}

const KEY_PATTERN = /^[0-9a-f]{40}$/;

function str(value: unknown, limit: number): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parsePastSession(value: unknown): AgentPastSession | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const key = str(raw['key'], 64);
	const title = str(raw['title'], 400);
	const updatedAt = num(raw['updatedAt']);
	if (key === undefined || !KEY_PATTERN.test(key) || (raw['agent'] !== 'claude' && raw['agent'] !== 'codex') || title === undefined || updatedAt === undefined) {
		return undefined;
	}
	const preview = str(raw['preview'], 600);
	const createdAt = num(raw['createdAt']);
	const branch = str(raw['branch'], 400);
	const terminalKey = str(raw['terminalKey'], 200);
	return {
		key, agent: raw['agent'], title, updatedAt,
		...(preview !== undefined ? { preview } : {}),
		...(raw['previewRole'] === 'user' || raw['previewRole'] === 'assistant' ? { previewRole: raw['previewRole'] } : {}),
		...(createdAt !== undefined ? { createdAt } : {}),
		...(branch !== undefined ? { branch } : {}),
		...(terminalKey !== undefined ? { terminalKey } : {}),
	};
}

/** `agentSessions` の返事を読む。 */
export function parseAgentPastSessionPage(reply: Record<string, unknown>): AgentPastSessionPage {
	const sessions = Array.isArray(reply['sessions']) ? reply['sessions'].map(parsePastSession).filter((session): session is AgentPastSession => session !== undefined) : [];
	const nextOffset = num(reply['nextOffset']);
	return { sessions, total: num(reply['total']) ?? sessions.length, ...(nextOffset !== undefined ? { nextOffset } : {}) };
}

/** `agentSessionPreview` の返事を読む。会話が読めなければ undefined。 */
export function parseAgentPastSessionPreview(reply: Record<string, unknown>): AgentPastSessionPreview | undefined {
	const session = parsePastSession(reply['session']);
	if (session === undefined) {
		return undefined;
	}
	const messages: AgentPastSessionMessage[] = [];
	for (const candidate of Array.isArray(reply['messages']) ? reply['messages'].slice(-200) : []) {
		if (candidate === null || typeof candidate !== 'object') {
			continue;
		}
		const raw = candidate as Record<string, unknown>;
		const text = str(raw['text'], 8_000);
		const ts = num(raw['ts']);
		if ((raw['role'] === 'user' || raw['role'] === 'assistant') && text !== undefined) {
			messages.push({ role: raw['role'], text, ...(ts !== undefined ? { ts } : {}) });
		}
	}
	return { session, messages, truncated: reply['truncated'] === true };
}

/** `agentSessionResume` の返事を読む。 */
export function parseAgentResumeResult(reply: Record<string, unknown>): AgentResumeResult | undefined {
	const status = reply['status'];
	if (status !== 'resumed' && status !== 'running' && status !== 'needs-trust' && status !== 'duplicate') {
		return undefined;
	}
	const terminalKey = str(reply['terminalKey'], 200);
	const message = str(reply['message'], 500);
	return {
		status,
		...(terminalKey !== undefined ? { terminalKey } : {}),
		...(typeof reply['delivered'] === 'boolean' ? { delivered: reply['delivered'] } : {}),
		...(message !== undefined ? { message } : {}),
	};
}

// ---- PC に届かない間の送信の預かり ----------------------------------------------------------

/** 預かった送信の宛先。`ws` は PC のスペースの id（`sourceId`。アプリの画面の id と違い、PC を再起動しても変わらない）。 */
export type AgentSendTarget =
	/** 開いていたターミナル（のエージェント）。`resumeKey` はターミナルが閉じていたときに再開するための指紋。 */
	| { readonly kind: 'live'; readonly terminalKey: string; readonly ws?: string; readonly resumeKey?: string; readonly title?: string }
	/** 過去の会話（再開して送る）。 */
	| { readonly kind: 'resume'; readonly ws: string; readonly key: string; readonly title?: string };

/**
 * 預かった送信の状態。
 * - waiting: PC につながるのを待っている
 * - sending: 送っている
 * - needs-confirm: 再開して送ってよいかを利用者に確かめる（ターミナルが閉じていた・過去の会話宛て）
 * - failed: 送れなかった（理由は `error`。［もう一度送る］で waiting に戻す）
 * - expired: 24 時間を過ぎた（送らない）
 */
export type AgentSendStatus = 'waiting' | 'sending' | 'needs-confirm' | 'failed' | 'expired';

export interface AgentSendQueueItem {
	/** 送信の ID（PC の重複排除にも使う）。 */
	readonly id: string;
	readonly pcId: string;
	readonly createdAt: number;
	readonly text: string;
	readonly target: AgentSendTarget;
	readonly status: AgentSendStatus;
	readonly error?: string;
}

/** 期限を過ぎたものを expired にする。変わらなければ同じ配列を返す。 */
export function expireAgentSendQueue(items: readonly AgentSendQueueItem[], now: number): readonly AgentSendQueueItem[] {
	let changed = false;
	const next = items.map(item => {
		if (item.status !== 'expired' && item.status !== 'sending' && now - item.createdAt > AGENT_SEND_QUEUE_TTL_MS) {
			changed = true;
			return { ...item, status: 'expired' as const };
		}
		return item;
	});
	return changed ? next : items;
}

/** つながったときに 1 件をどうするか。 */
export type AgentSendPlan =
	| { readonly kind: 'send'; readonly item: AgentSendQueueItem }
	| { readonly kind: 'confirm'; readonly item: AgentSendQueueItem }
	| { readonly kind: 'fail'; readonly item: AgentSendQueueItem; readonly error: string };

/**
 * つながったときに、待っている送信をどうするかを決める（古い順）。`terminals` は PC の今のターミナル。
 * 開いているエージェントのターミナル宛てだけを送る。閉じていれば、指紋があれば「再開して送る」の確認へ、無ければ失敗。
 * 過去の会話宛ては必ず確認へ（黙って再開しない）。
 */
export function planAgentSendQueue(items: readonly AgentSendQueueItem[], pcId: string, terminals: readonly { readonly terminalKey: string; readonly agent?: boolean }[]): readonly AgentSendPlan[] {
	const plans: AgentSendPlan[] = [];
	const waiting = items.filter(item => item.pcId === pcId && item.status === 'waiting').sort((a, b) => a.createdAt - b.createdAt);
	for (const item of waiting) {
		if (item.target.kind === 'resume') {
			plans.push({ kind: 'confirm', item });
			continue;
		}
		const terminalKey = item.target.terminalKey;
		const terminal = terminals.find(candidate => candidate.terminalKey === terminalKey);
		if (terminal !== undefined && terminal.agent === true) {
			plans.push({ kind: 'send', item });
		} else if (item.target.resumeKey !== undefined && item.target.ws !== undefined) {
			plans.push({ kind: 'confirm', item });
		} else {
			plans.push({ kind: 'fail', item, error: '宛先のターミナルが閉じられていたため送れませんでした' });
		}
	}
	return plans;
}

/** 預かりに足す（同じ PC の上限を超えたら古いものから捨てる）。 */
export function addAgentSendQueueItem(items: readonly AgentSendQueueItem[], item: AgentSendQueueItem): readonly AgentSendQueueItem[] {
	const samePc = items.filter(candidate => candidate.pcId === item.pcId);
	const overflow = Math.max(0, samePc.length + 1 - AGENT_SEND_QUEUE_LIMIT);
	const dropped = new Set(samePc.sort((a, b) => a.createdAt - b.createdAt).slice(0, overflow).map(candidate => candidate.id));
	return [...items.filter(candidate => !dropped.has(candidate.id)), item];
}

/** 「再開して送る」に使う宛先（過去の会話か、閉じたターミナルの会話）。送れないなら undefined。 */
export function agentSendResumeTarget(item: AgentSendQueueItem): { readonly ws: string; readonly key: string } | undefined {
	if (item.target.kind === 'resume') {
		return { ws: item.target.ws, key: item.target.key };
	}
	return item.target.resumeKey !== undefined && item.target.ws !== undefined ? { ws: item.target.ws, key: item.target.resumeKey } : undefined;
}

/** 保存する形（1 台の PC ぶん）。 */
export function serializeAgentSendQueue(pcId: string, items: readonly AgentSendQueueItem[]): string {
	return JSON.stringify({ version: 1, pcId, items: items.filter(item => item.pcId === pcId) });
}

/** 保存した形を読む。PC が違う・形が違うものは捨てる。送っている途中で止まったものは待ちに戻す。 */
export function deserializeAgentSendQueue(pcId: string, text: string): readonly AgentSendQueueItem[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const root = parsed as { version?: unknown; pcId?: unknown; items?: unknown };
	if (root === null || typeof root !== 'object' || root.version !== 1 || root.pcId !== pcId || !Array.isArray(root.items)) {
		return [];
	}
	const items: AgentSendQueueItem[] = [];
	for (const candidate of root.items.slice(0, AGENT_SEND_QUEUE_LIMIT)) {
		const item = candidate as Partial<AgentSendQueueItem> | null;
		const target = item?.target as AgentSendTarget | undefined;
		const validTarget = target !== undefined && target !== null && ((target.kind === 'live' && typeof target.terminalKey === 'string')
			|| (target.kind === 'resume' && typeof target.ws === 'string' && typeof target.key === 'string' && KEY_PATTERN.test(target.key)));
		if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || item.pcId !== pcId || typeof item.createdAt !== 'number'
			|| typeof item.text !== 'string' || item.text.length === 0 || item.text.length > AGENT_RESUME_PROMPT_LIMIT || !validTarget
			|| !['waiting', 'sending', 'needs-confirm', 'failed', 'expired'].includes(item.status as string)) {
			continue;
		}
		items.push({
			id: item.id, pcId, createdAt: item.createdAt, text: item.text, target: target as AgentSendTarget,
			status: item.status === 'sending' ? 'waiting' : item.status as AgentSendStatus,
			...(typeof item.error === 'string' ? { error: item.error } : {}),
		});
	}
	return items;
}

/** 預かりの行の状態の文。 */
export function agentSendStatusText(item: AgentSendQueueItem): string {
	switch (item.status) {
		case 'waiting': return 'PC に届き次第送ります';
		case 'sending': return '送っています';
		case 'needs-confirm': return item.target.kind === 'resume' ? '会話を再開して送るか確かめてください' : 'ターミナルが閉じられていました。会話を再開して送れます';
		case 'failed': return item.error ?? '送れませんでした';
		case 'expired': return '24 時間を過ぎたので送りませんでした';
	}
}
