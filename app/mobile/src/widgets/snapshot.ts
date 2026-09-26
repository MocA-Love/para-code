// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ホーム画面・ロック画面のウィジェットへ渡す要約（スナップショット）の形と組み立て。
 *
 * ウィジェットは自分で PC やリレーへ繋がない。アプリ（と通知拡張）が App Group に書いたこの要約を
 * 読んで描くだけ。形は Swift 側（`native/ParaCodeWidgets/WidgetShared.swift` の `WidgetSnapshot`）と
 * 一致させること。どちらかだけ変えると、ウィジェットが読めずに「未ペアリング」の表示へ落ちる。
 *
 * 機微情報の扱い:
 *  - エージェントの名前・スペース名・ブランチ・コミット文・ファイル名は端末内の App Group にだけ置く
 *    （リレーや PC へは何も増やさない）。ロック画面では Swift 側で privacySensitive を付ける
 *  - 質問文とコマンド（`detail`）は、アプリの設定で「表示する」を選んだときだけ入れる（既定は入れない）
 *  - 長さは切り詰める（名前 40 字、質問文 120 字、コミット文 80 字、パス 120 字）
 *
 * ここは画面から切り離した純関数だけを置く（`snapshot.test.ts`）。ストアの購読と書き出しは
 * `src/widgets/widgetSync.ts`。
 */

export const WIDGET_SNAPSHOT_VERSION = 1;

/** 名前（エージェント・スペース・PC）の上限。 */
export const WIDGET_TITLE_MAX = 40;
/** 質問文・コマンドの上限。 */
export const WIDGET_DETAIL_MAX = 120;
const COMMIT_SUBJECT_MAX = 80;
const PATH_MAX = 120;
const BRANCH_MAX = 60;
/** 1台あたりに載せるエージェントの上限（大サイズでも 8 行しか出さない）。 */
export const WIDGET_AGENTS_MAX = 24;
/** 1台あたりに載せるスペースの上限。 */
export const WIDGET_SPACES_MAX = 16;
/** スペース1つあたりに載せる変更ファイルの上限。 */
const SPACE_FILES_MAX = 5;
/** スペース1つあたりに載せるコミットの上限。 */
const SPACE_COMMITS_MAX = 3;

/**
 * エージェントの状態（モックの `approve` / `question` / `error` / `running` / `unread` / `idle`）。
 * `error` はアプリからは出さない（PC の状態に無い）。通知拡張がエラーの通知を受けたときだけ書く。
 */
export type WidgetAgentState = 'approve' | 'question' | 'error' | 'running' | 'unread' | 'idle';

export type WidgetAgentKind = 'claude' | 'codex' | 'agent';

export interface WidgetAgent {
	/** PC のターミナルの論理 ID（`terminalKey`）。ディープリンクと「確認済みにする」に使う。 */
	readonly key: string;
	readonly title: string;
	readonly kind: WidgetAgentKind;
	readonly spaceId?: string;
	readonly state: WidgetAgentState;
	/** 今の状態になったのをこの端末が見た時刻（epoch ms）。分からなければ無し（時刻をでっち上げない）。 */
	readonly since?: number;
	/** 質問文やコマンド。設定で許したときだけ入る。 */
	readonly detail?: string;
}

export interface WidgetSpaceFile {
	/** git status の1文字（A / M / D / R / U / ?）。 */
	readonly code: string;
	readonly path: string;
}

export interface WidgetSpaceCommit {
	readonly subject: string;
	readonly at?: number;
}

export interface WidgetSpace {
	readonly id: string;
	readonly name: string;
	readonly branch?: string;
	/** 変更のあるファイルの数。取れていなければ無し。 */
	readonly changes?: number;
	readonly files?: readonly WidgetSpaceFile[];
	readonly commits?: readonly WidgetSpaceCommit[];
	/** 変更・コミットを取った時刻。 */
	readonly scmAt?: number;
}

export type WidgetLimitKey = 'claude5h' | 'claudeWeek' | 'codex5h' | 'codexWeek';

export interface WidgetLimit {
	readonly key: WidgetLimitKey;
	readonly label: string;
	/** 0〜100。 */
	readonly usedPercent: number;
	readonly resetsAt?: number;
}

export interface WidgetUsage {
	readonly todayCost?: number;
	readonly costClaude?: number;
	readonly costCodex?: number;
	readonly limits: readonly WidgetLimit[];
	/** コストと上限を取った時刻。 */
	readonly fetchedAt: number;
}

export interface WidgetResources {
	/** 0〜100。 */
	readonly cpu?: number;
	/** 0〜100。 */
	readonly memPercent?: number;
	readonly memTotal?: number;
	readonly diskFree?: number;
	readonly diskTotal?: number;
}

export interface WidgetPc {
	readonly id: string;
	readonly name: string;
	/** リレーに繋がっていて、PC の Para Code も動いている。 */
	readonly online: boolean;
	/** 最後に PC がオンラインだと確かめた時刻。 */
	readonly lastSeenAt?: number;
	/** エージェント・スペース・リソースを取った時刻（中身を持っていなければ無し）。 */
	readonly updatedAt?: number;
	/** 通知拡張が要対応を書き換えた時刻（アプリは書かない）。 */
	readonly eventAt?: number;
	readonly battery?: { readonly level: number; readonly charging: boolean };
	readonly resources?: WidgetResources;
	readonly usage?: WidgetUsage;
	/** 要対応の件数。見ていない PC でも接続を保っていれば正しい。 */
	readonly attention: number;
	readonly agents: readonly WidgetAgent[];
	readonly spaces: readonly WidgetSpace[];
}

export interface WidgetSnapshot {
	readonly v: typeof WIDGET_SNAPSHOT_VERSION;
	readonly writtenAt: number;
	readonly source: 'app' | 'nse' | 'widget';
	readonly paired: boolean;
	/** アプリで見ている PC（ウィジェットの PC の設定が「アプリで見ている PC」のときの行き先）。 */
	readonly activePcId?: string;
	readonly pcs: readonly WidgetPc[];
}

/** 「確認済みにしたい」の積み置き（ウィジェットのボタンが積み、アプリが PC へ送って消す）。 */
export interface WidgetOutboxEntry {
	readonly t: 'dismiss';
	readonly pcId: string;
	readonly key: string;
	readonly at: number;
}

// ---------------------------------------------------------------------------
// 入力（ストアから取り出した材料）

export interface SnapshotTerminalInput {
	readonly terminalKey: string;
	readonly title: string;
	readonly ws?: string;
	readonly agent?: boolean;
	readonly agentStatus?: string;
}

export interface SnapshotChatInput {
	readonly agent?: string;
	readonly interaction?: { readonly kind: 'question' | 'approval'; readonly title?: string; readonly detail?: string };
	readonly messages?: readonly { readonly kind?: string; readonly text?: string }[];
}

export interface SnapshotPcSummaryInput {
	readonly id: string;
	readonly name: string;
	readonly connection: string;
	readonly pcOnline: boolean;
	readonly waiting: number;
	readonly lastOnlineAt: number | undefined;
	readonly battery: { readonly level: number; readonly charging: boolean } | undefined;
}

export interface SnapshotActiveInput {
	readonly workspaces: readonly { readonly id: string; readonly name: string; readonly branch?: string }[];
	readonly terminals: readonly SnapshotTerminalInput[];
	readonly chats: ReadonlyMap<string, SnapshotChatInput>;
	readonly resources?: { readonly cpu?: number; readonly memUsed: number; readonly memTotal: number; readonly diskFree?: number; readonly diskTotal?: number };
	/** 状態が変わった時刻（`features/pc/statusSince.ts` の記録）。 */
	readonly statusSince: ReadonlyMap<string, { readonly status: string | undefined; readonly since: number | undefined }>;
	readonly usage?: WidgetUsage;
	readonly scm: ReadonlyMap<string, { readonly branch?: string; readonly files: readonly { readonly x: string; readonly y: string; readonly path: string }[]; readonly commits: readonly { readonly subject: string; readonly at?: number }[]; readonly at: number }>;
}

export interface SnapshotInput {
	readonly ready: boolean;
	readonly pcs: readonly SnapshotPcSummaryInput[];
	readonly activePcId: string | undefined;
	/** いま見ている PC の中身。PC の状態がまだ届いていなければ undefined。 */
	readonly active: SnapshotActiveInput | undefined;
	/** 質問文とコマンドを入れるか（アプリの設定）。 */
	readonly includeDetail: boolean;
	/** まだ PC へ送れていない「確認済みにしたい」。ウィジェットの表示を先に変えたままにする。 */
	readonly outbox: readonly WidgetOutboxEntry[];
}

// ---------------------------------------------------------------------------

/** ストアの `agentStatus` をウィジェットの状態へ。判定は `src/agentStatus.ts` と同じ区切り。 */
export function widgetAgentState(agent: boolean | undefined, agentStatus: string | undefined): WidgetAgentState {
	if (agent !== true || agentStatus === undefined) {
		return 'idle';
	}
	if (agentStatus === 'permission') {
		return 'approve';
	}
	if (agentStatus === 'question') {
		return 'question';
	}
	if (agentStatus === 'working') {
		return 'running';
	}
	return 'unread';
}

/** 要対応（止めているもの）か。 */
export function isWidgetAttention(state: WidgetAgentState): boolean {
	return state === 'approve' || state === 'question';
}

/** 1行に収め、上限で切る（上限を超えたら末尾を「…」にする）。空なら undefined。 */
export function clampText(text: string | undefined, max: number): string | undefined {
	if (text === undefined) {
		return undefined;
	}
	const line = text.replace(/\s+/g, ' ').trim();
	if (line.length === 0) {
		return undefined;
	}
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function widgetAgentKind(chatAgent: string | undefined, title: string): WidgetAgentKind {
	const source = (chatAgent ?? title).toLowerCase();
	if (source.includes('claude')) {
		return 'claude';
	}
	if (source.includes('codex')) {
		return 'codex';
	}
	return 'agent';
}

/**
 * 質問文・コマンド。許可待ちは「ツール名: コマンド」、質問は最後の質問の本文。
 * 会話を一度も開いていないエージェントは手元に写しが無いので出せない（無しにする）。
 */
export function agentDetail(state: WidgetAgentState, chat: SnapshotChatInput | undefined): string | undefined {
	if (chat === undefined) {
		return undefined;
	}
	if (state === 'approve') {
		const interaction = chat.interaction;
		if (interaction === undefined || interaction.kind !== 'approval') {
			return undefined;
		}
		const title = clampText(interaction.title, WIDGET_DETAIL_MAX);
		const detail = clampText(interaction.detail, WIDGET_DETAIL_MAX);
		return clampText(title !== undefined && detail !== undefined ? `${title}: ${detail}` : title ?? detail, WIDGET_DETAIL_MAX);
	}
	if (state === 'question') {
		const messages = chat.messages ?? [];
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message !== undefined && message.kind === 'question') {
				return clampText(message.text, WIDGET_DETAIL_MAX);
			}
		}
	}
	return undefined;
}

function finiteOrUndefined(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function percent(used: number, total: number): number | undefined {
	if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
		return undefined;
	}
	return Math.round(Math.min(100, Math.max(0, (used / total) * 100)));
}

function buildAgents(active: SnapshotActiveInput, includeDetail: boolean, previous: WidgetPc | undefined, dismissed: ReadonlySet<string>): WidgetAgent[] {
	const previousByKey = new Map((previous?.agents ?? []).map(agent => [agent.key, agent]));
	const agents: WidgetAgent[] = [];
	for (const terminal of active.terminals) {
		if (terminal.agent !== true) {
			continue;
		}
		let state = widgetAgentState(terminal.agent, terminal.agentStatus);
		// ウィジェットで確認済みにしたものは、PC が受け取るまで待機として見せる（押したのに戻らないように）。
		if (state === 'unread' && dismissed.has(terminal.terminalKey)) {
			state = 'idle';
		}
		const chat = active.chats.get(terminal.terminalKey);
		const seen = active.statusSince.get(terminal.terminalKey);
		const before = previousByKey.get(terminal.terminalKey);
		// 目の前で変わった時刻を優先し、無ければ前回の要約の時刻を引き継ぐ（状態が同じときだけ）。
		const since = (seen !== undefined && seen.status === terminal.agentStatus ? seen.since : undefined)
			?? (before !== undefined && before.state === state ? before.since : undefined);
		const detail = includeDetail ? agentDetail(state, chat) : undefined;
		const spaceId = terminal.ws;
		agents.push({
			key: terminal.terminalKey,
			title: clampText(terminal.title, WIDGET_TITLE_MAX) ?? 'エージェント',
			kind: widgetAgentKind(chat?.agent, terminal.title),
			...(spaceId !== undefined ? { spaceId } : {}),
			state,
			...(since !== undefined ? { since } : {}),
			...(detail !== undefined ? { detail } : {}),
		});
	}
	return sortWidgetAgents(agents).slice(0, WIDGET_AGENTS_MAX);
}

const STATE_ORDER: Readonly<Record<WidgetAgentState, number>> = { approve: 0, question: 1, error: 2, running: 3, unread: 4, idle: 5 };

/** 要対応を先に、同じ状態の中は古い順（長く待たせているものを上に）。時刻の分からないものは後ろ。 */
export function sortWidgetAgents<T extends Pick<WidgetAgent, 'state' | 'since'>>(agents: readonly T[]): T[] {
	return [...agents].sort((a, b) => {
		const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
		if (byState !== 0) {
			return byState;
		}
		return (a.since ?? Number.MAX_SAFE_INTEGER) - (b.since ?? Number.MAX_SAFE_INTEGER);
	});
}

function buildSpaces(active: SnapshotActiveInput): WidgetSpace[] {
	return active.workspaces.slice(0, WIDGET_SPACES_MAX).map(workspace => {
		const scm = active.scm.get(workspace.id);
		const branch = clampText(scm?.branch ?? workspace.branch, BRANCH_MAX);
		const files = scm?.files.slice(0, SPACE_FILES_MAX).map(file => ({
			code: statusCode(file.x, file.y),
			path: clampText(file.path, PATH_MAX) ?? '',
		}));
		const commits = scm?.commits.slice(0, SPACE_COMMITS_MAX).map(commit => ({
			subject: clampText(commit.subject, COMMIT_SUBJECT_MAX) ?? '',
			...(finiteOrUndefined(commit.at) !== undefined ? { at: commit.at } : {}),
		}));
		return {
			id: workspace.id,
			name: clampText(workspace.name, WIDGET_TITLE_MAX) ?? workspace.id,
			...(branch !== undefined ? { branch } : {}),
			...(scm !== undefined ? { changes: scm.files.length, files, commits, scmAt: scm.at } : {}),
		};
	});
}

/** git status の2文字から、行頭に出す1文字を選ぶ（作業ツリー側を優先）。 */
export function statusCode(x: string, y: string): string {
	const pick = (c: string) => (c === ' ' || c === '' ? undefined : c);
	const code = pick(y) ?? pick(x) ?? 'M';
	return code === '?' ? 'A' : code;
}

function buildResources(active: SnapshotActiveInput): WidgetResources | undefined {
	const raw = active.resources;
	if (raw === undefined) {
		return undefined;
	}
	const cpu = finiteOrUndefined(raw.cpu);
	const memPercent = percent(raw.memUsed, raw.memTotal);
	return {
		...(cpu !== undefined ? { cpu: Math.round(Math.min(100, Math.max(0, cpu))) } : {}),
		...(memPercent !== undefined ? { memPercent, memTotal: raw.memTotal } : {}),
		...(finiteOrUndefined(raw.diskFree) !== undefined ? { diskFree: raw.diskFree } : {}),
		...(finiteOrUndefined(raw.diskTotal) !== undefined ? { diskTotal: raw.diskTotal } : {}),
	};
}

function dismissedKeys(outbox: readonly WidgetOutboxEntry[], pcId: string): Set<string> {
	return new Set(outbox.filter(entry => entry.t === 'dismiss' && entry.pcId === pcId).map(entry => entry.key));
}

/**
 * 要約を組み立てる。
 *
 * いま見ている PC は中身（エージェント・スペース・リソース・使用量）まで作り直す。見ていない PC は
 * ストアが件数とバッテリーしか持たないので、前回の要約にあった中身をそのまま残し（その時刻は
 * `updatedAt` に残る）、件数・接続・バッテリーだけを新しくする。ウィジェットは `updatedAt` から
 * 「◯分前の状態」を出す。
 */
export function buildWidgetSnapshot(input: SnapshotInput, previous: WidgetSnapshot | undefined, now: number): WidgetSnapshot {
	const previousPcs = new Map((previous?.pcs ?? []).map(pc => [pc.id, pc]));
	const pcs = input.pcs.map((summary): WidgetPc => {
		const before = previousPcs.get(summary.id);
		const online = summary.connection === 'online' && summary.pcOnline;
		const name = clampText(summary.name, WIDGET_TITLE_MAX) ?? 'PC';
		const base = {
			id: summary.id,
			name,
			online,
			...(summary.lastOnlineAt !== undefined ? { lastSeenAt: summary.lastOnlineAt } : before?.lastSeenAt !== undefined ? { lastSeenAt: before.lastSeenAt } : {}),
			...(summary.battery !== undefined ? { battery: { level: Math.round(summary.battery.level), charging: summary.battery.charging } } : {}),
			attention: summary.waiting,
		};
		const dismissed = dismissedKeys(input.outbox, summary.id);
		if (summary.id === input.activePcId && input.active !== undefined) {
			const agents = buildAgents(input.active, input.includeDetail, before, dismissed);
			const resources = buildResources(input.active);
			const usage = input.active.usage ?? before?.usage;
			return {
				...base,
				updatedAt: now,
				...(resources !== undefined ? { resources } : {}),
				...(usage !== undefined ? { usage } : {}),
				attention: agents.filter(agent => isWidgetAttention(agent.state)).length,
				agents,
				spaces: buildSpaces(input.active),
			};
		}
		// 見ていない PC: 前回の中身を残す。質問文は設定がオフになったら消す。
		const keptAgents = (before?.agents ?? []).map(agent => {
			const state = agent.state === 'unread' && dismissed.has(agent.key) ? 'idle' : agent.state;
			const { detail, ...rest } = agent;
			return { ...rest, state, ...(input.includeDetail && detail !== undefined ? { detail } : {}) };
		});
		return {
			...base,
			...(before?.updatedAt !== undefined ? { updatedAt: before.updatedAt } : {}),
			...(before?.eventAt !== undefined ? { eventAt: before.eventAt } : {}),
			...(before?.resources !== undefined ? { resources: before.resources } : {}),
			...(before?.usage !== undefined ? { usage: before.usage } : {}),
			agents: keptAgents,
			spaces: before?.spaces ?? [],
		};
	});
	return {
		v: WIDGET_SNAPSHOT_VERSION,
		writtenAt: now,
		source: 'app',
		paired: input.pcs.length > 0,
		...(input.activePcId !== undefined ? { activePcId: input.activePcId } : {}),
		pcs,
	};
}

/**
 * 書き出すかどうかの比較に使う鍵。`writtenAt` と、時刻だけが進む `updatedAt` を除いた中身で比べる
 * （中身が同じなら書かない。ウィジェットのリロードを無駄に起こさないため）。
 */
export function snapshotContentKey(snapshot: WidgetSnapshot): string {
	return JSON.stringify({
		...snapshot,
		writtenAt: 0,
		pcs: snapshot.pcs.map(pc => ({ ...pc, updatedAt: pc.updatedAt !== undefined ? 1 : 0 })),
	});
}

// ---------------------------------------------------------------------------
// 積み置き（ウィジェットの「確認済みにする」）

/** 積み置きを置いておく上限（押してからアプリを開くまでの間）。過ぎたら捨てる。 */
export const WIDGET_OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;

/** App Group から読んだ積み置きの JSON を検証する。形の合わないものは捨てる。 */
export function parseWidgetOutbox(raw: string | undefined | null, now: number): WidgetOutboxEntry[] {
	if (raw === undefined || raw === null || raw.length === 0) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const list = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { entries?: unknown }).entries : undefined;
	if (!Array.isArray(list)) {
		return [];
	}
	const entries: WidgetOutboxEntry[] = [];
	for (const item of list) {
		if (item === null || typeof item !== 'object') {
			continue;
		}
		const record = item as Record<string, unknown>;
		const pcId = record['pcId'];
		const key = record['key'];
		const at = record['at'];
		if (record['t'] !== 'dismiss' || typeof pcId !== 'string' || pcId.length === 0 || pcId.length > 200
			|| typeof key !== 'string' || key.length === 0 || key.length > 200 || typeof at !== 'number' || !Number.isFinite(at)) {
			continue;
		}
		if (now - at > WIDGET_OUTBOX_TTL_MS) {
			continue;
		}
		entries.push({ t: 'dismiss', pcId, key, at });
	}
	return entries;
}

export interface OutboxPlan {
	/** いま PC へ確認済みを送るターミナル。 */
	readonly send: readonly string[];
	/** 積み置きから消してよいもの（送り終えた・もう未確認ではない・ターミナルが無い）。 */
	readonly remove: readonly { readonly pcId: string; readonly key: string }[];
}

/**
 * 積み置きをどう片付けるか。いま見ている PC に繋がっていて状態が揃っているときだけ動く
 * （ほかの PC のぶんは、その PC を開くまで残す）。送るのは既存の「確認済みにする」
 * （`ackAgentStatus`）で、PC の状態が「未確認」でなくなったら積み置きから消す。
 */
export function planWidgetOutbox(input: {
	readonly entries: readonly WidgetOutboxEntry[];
	readonly activePcId: string | undefined;
	readonly online: boolean;
	readonly terminals: readonly SnapshotTerminalInput[] | undefined;
	/** この起動のうちに送ったもの（`pcId` と `key` を連ねた鍵）。 */
	readonly alreadySent: ReadonlySet<string>;
}): OutboxPlan {
	if (!input.online || input.activePcId === undefined || input.terminals === undefined) {
		return { send: [], remove: [] };
	}
	const byKey = new Map(input.terminals.map(terminal => [terminal.terminalKey, terminal]));
	const send: string[] = [];
	const remove: { pcId: string; key: string }[] = [];
	for (const entry of input.entries) {
		if (entry.pcId !== input.activePcId) {
			continue;
		}
		const terminal = byKey.get(entry.key);
		const state = terminal === undefined ? undefined : widgetAgentState(terminal.agent, terminal.agentStatus);
		if (state !== 'unread') {
			remove.push({ pcId: entry.pcId, key: entry.key });
			continue;
		}
		if (!input.alreadySent.has(outboxSentKey(entry.pcId, entry.key))) {
			send.push(entry.key);
		}
	}
	return { send, remove };
}

export function outboxSentKey(pcId: string, key: string): string {
	return `${pcId}\u0000${key}`;
}

// ---------------------------------------------------------------------------
// 前回の要約（見ていない PC の中身を引き継ぐためだけに読む）

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

const AGENT_STATES: readonly WidgetAgentState[] = ['approve', 'question', 'error', 'running', 'unread', 'idle'];

function parseAgent(raw: unknown): WidgetAgent | undefined {
	if (raw === null || typeof raw !== 'object') {
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	const key = r['key'];
	const title = r['title'];
	const state = r['state'];
	if (typeof key !== 'string' || key.length === 0 || typeof title !== 'string' || typeof state !== 'string' || !(AGENT_STATES as readonly string[]).includes(state)) {
		return undefined;
	}
	const kind = r['kind'] === 'claude' || r['kind'] === 'codex' ? r['kind'] : 'agent';
	const detail = typeof r['detail'] === 'string' ? clampText(r['detail'], WIDGET_DETAIL_MAX) : undefined;
	return {
		key,
		title: clampText(title, WIDGET_TITLE_MAX) ?? 'エージェント',
		kind,
		...(typeof r['spaceId'] === 'string' ? { spaceId: r['spaceId'] } : {}),
		state: state as WidgetAgentState,
		...(isFiniteNumber(r['since']) ? { since: r['since'] } : {}),
		...(detail !== undefined ? { detail } : {}),
	};
}

function parseSpace(raw: unknown): WidgetSpace | undefined {
	if (raw === null || typeof raw !== 'object') {
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	if (typeof r['id'] !== 'string' || typeof r['name'] !== 'string') {
		return undefined;
	}
	const files = Array.isArray(r['files'])
		? r['files'].filter((f): f is WidgetSpaceFile => f !== null && typeof f === 'object' && typeof (f as Record<string, unknown>)['code'] === 'string' && typeof (f as Record<string, unknown>)['path'] === 'string').slice(0, SPACE_FILES_MAX)
		: undefined;
	const commits = Array.isArray(r['commits'])
		? r['commits'].filter((c): c is WidgetSpaceCommit => c !== null && typeof c === 'object' && typeof (c as Record<string, unknown>)['subject'] === 'string').slice(0, SPACE_COMMITS_MAX)
		: undefined;
	return {
		id: r['id'],
		name: r['name'],
		...(typeof r['branch'] === 'string' ? { branch: r['branch'] } : {}),
		...(isFiniteNumber(r['changes']) ? { changes: r['changes'] } : {}),
		...(files !== undefined ? { files } : {}),
		...(commits !== undefined ? { commits } : {}),
		...(isFiniteNumber(r['scmAt']) ? { scmAt: r['scmAt'] } : {}),
	};
}

function parsePc(raw: unknown): WidgetPc | undefined {
	if (raw === null || typeof raw !== 'object') {
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	if (typeof r['id'] !== 'string' || typeof r['name'] !== 'string') {
		return undefined;
	}
	const agents = Array.isArray(r['agents']) ? r['agents'].map(parseAgent).filter((a): a is WidgetAgent => a !== undefined).slice(0, WIDGET_AGENTS_MAX) : [];
	const spaces = Array.isArray(r['spaces']) ? r['spaces'].map(parseSpace).filter((s): s is WidgetSpace => s !== undefined).slice(0, WIDGET_SPACES_MAX) : [];
	const battery = r['battery'] as Record<string, unknown> | undefined;
	const usage = r['usage'] as Record<string, unknown> | undefined;
	const resources = r['resources'];
	return {
		id: r['id'],
		name: r['name'],
		online: r['online'] === true,
		...(isFiniteNumber(r['lastSeenAt']) ? { lastSeenAt: r['lastSeenAt'] } : {}),
		...(isFiniteNumber(r['updatedAt']) ? { updatedAt: r['updatedAt'] } : {}),
		...(isFiniteNumber(r['eventAt']) ? { eventAt: r['eventAt'] } : {}),
		...(battery !== undefined && battery !== null && isFiniteNumber(battery['level']) && typeof battery['charging'] === 'boolean' ? { battery: { level: battery['level'], charging: battery['charging'] } } : {}),
		...(resources !== null && typeof resources === 'object' ? { resources: resources as WidgetResources } : {}),
		...(usage !== undefined && usage !== null && isFiniteNumber(usage['fetchedAt']) && Array.isArray(usage['limits']) ? { usage: usage as unknown as WidgetUsage } : {}),
		attention: isFiniteNumber(r['attention']) ? r['attention'] : agents.filter(agent => isWidgetAttention(agent.state)).length,
		agents,
		spaces,
	};
}

/** App Group から読んだ要約を検証する。版が違う・壊れているなら undefined。 */
export function parseWidgetSnapshot(raw: string | undefined | null): WidgetSnapshot | undefined {
	if (raw === undefined || raw === null || raw.length === 0) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== 'object') {
		return undefined;
	}
	const r = parsed as Record<string, unknown>;
	if (r['v'] !== WIDGET_SNAPSHOT_VERSION || !Array.isArray(r['pcs']) || !isFiniteNumber(r['writtenAt'])) {
		return undefined;
	}
	const source = r['source'] === 'nse' || r['source'] === 'widget' ? r['source'] : 'app';
	return {
		v: WIDGET_SNAPSHOT_VERSION,
		writtenAt: r['writtenAt'],
		source,
		paired: r['paired'] === true,
		...(typeof r['activePcId'] === 'string' ? { activePcId: r['activePcId'] } : {}),
		pcs: r['pcs'].map(parsePc).filter((pc): pc is WidgetPc => pc !== undefined),
	};
}
