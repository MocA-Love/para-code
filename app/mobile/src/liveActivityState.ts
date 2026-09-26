// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type {
	LiveActivityAttentionItem,
	LiveActivityAttributes,
	LiveActivityDoneItem,
	LiveActivityRunningItem,
	LiveActivityState,
} from '../modules/para-live-activity/index.js';
import { agentStatusKind } from './agentStatus.js';
import { clampText } from './widgets/snapshot.js';

/**
 * Live Activity（案 D「状態で切り替え」）の中身を組み立てる純関数。ストアの購読とネイティブへの
 * 受け渡しは `src/liveActivitySync.ts`。ここは画面・ネイティブから切り離してテストする
 * （`liveActivityState.test.ts`）。
 *
 * 状態（phase）は4つで、Swift 側（`native/ParaCodeWidgets/ParaCodeLiveActivity.swift`）が形を切り替える:
 *  - attention: 要対応が1件以上。一番長く待たせている1件と、実行中の1行
 *  - running: 実行中だけ。最大2行（経過時間・最後のツール）
 *  - done: 全部終わった。この Live Activity の間に終わったものの要約を、最長 15 分ロック画面に残して終える
 *  - offline: PC に繋がらない。直前の中身を灰色にして、最後に PC を見た時刻を出す
 *
 * 段階 2（ActivityKit のプッシュ）では PC がこの形の content-state を作る。そのときも形はここと Swift に合わせる。
 */

/** 名前（作業名・PC 名）の上限。 */
export const LIVE_NAME_MAX = 40;
/** コマンド・質問文の上限（1行で切れるので、それ以上は持たない）。 */
export const LIVE_DETAIL_MAX = 80;
/** ツール名の上限。 */
export const LIVE_TOOL_MAX = 24;
/** ツールの対象（ファイルのパスなど）の上限。 */
export const LIVE_TARGET_MAX = 60;
export const LIVE_ATTENTION_MAX = 2;
export const LIVE_RUNNING_MAX = 2;
export const LIVE_DONE_MAX = 3;
/** 最後の更新からこれだけ過ぎたら「古い」表示にする（staleDate）。 */
export const LIVE_STALE_AFTER_MS = 2 * 60_000;
/** 完了の要約をロック画面に残す長さ（dismissalPolicy .after）。 */
export const LIVE_DONE_LINGER_MS = 15 * 60_000;
/** 中身が同じでも送り直す間隔（前面にいる間に staleDate を先へ送るため）。 */
export const LIVE_HEARTBEAT_MS = 60_000;
/** PC に繋がらない状態がこれだけ続いたら「オフライン」にする（前面へ戻った直後の再接続の間に出さないため）。 */
export const LIVE_OFFLINE_GRACE_MS = 10_000;
/**
 * 静的属性と中身を JSON にしたときの上限（バイト）。Apple の上限は合わせて 4KB だが、ActivityKit 側の
 * 符号化の差を見込んで 3KB に抑える。
 */
export const LIVE_ACTIVITY_MAX_BYTES = 3_072;

// ---------------------------------------------------------------------------
// 入力（ストアから取り出した材料）

export interface LiveTerminalInput {
	readonly terminalKey: string;
	readonly title: string;
	readonly ws?: string;
	readonly agent?: boolean;
	readonly agentStatus?: string;
}

export interface LiveChatInput {
	readonly interaction?: { readonly kind: 'question' | 'approval'; readonly title?: string; readonly detail?: string };
	readonly live?: { readonly phase: string; readonly tool?: string; readonly detail?: string };
	readonly messages?: readonly { readonly kind?: string; readonly text?: string }[];
	readonly none?: boolean;
}

export type LiveStatusSince = ReadonlyMap<string, { readonly status: string | undefined; readonly since: number | undefined }>;

// ---------------------------------------------------------------------------
// 覚えておくもの（どれがこの Live Activity の間に終わったか）

export interface LiveMemory {
	/** 対象の PC。変わったら全部捨てる。 */
	readonly pcId: string | undefined;
	/** いま実行中・要対応のターミナルと、作業を始めたのを見た時刻（見ていなければ無し）。 */
	readonly working: ReadonlyMap<string, { readonly start?: number }>;
	/** この Live Activity の間に終わって、まだ未確認のもの。 */
	readonly finished: ReadonlyMap<string, { readonly at: number; readonly took?: number }>;
}

export const EMPTY_LIVE_MEMORY: LiveMemory = { pcId: undefined, working: new Map(), finished: new Map() };

function sinceOf(statusSince: LiveStatusSince, terminal: LiveTerminalInput): number | undefined {
	const seen = statusSince.get(terminal.terminalKey);
	return seen !== undefined && seen.status === terminal.agentStatus ? seen.since : undefined;
}

/**
 * ターミナルの最新の並びで「作業中」「終わった」の記録を進める。
 *
 * - 実行中・要対応になったら作業中として覚える（始まりの時刻は目の前で変わったときだけ持つ）
 * - 作業中だったものが未確認（作業を終えた状態）になったら「終わった」へ移す
 * - 待機（確認済み）になった・ターミナルが消えたら、どちらからも落とす（未確認でなくなったので）
 * - `alive`（Live Activity が出ている）でないときに作業が始まったら、前回の「終わった」は捨てる
 *   （新しい Live Activity の完了の要約に、前回のぶんを混ぜない）
 */
export function nextLiveMemory(previous: LiveMemory, input: {
	readonly pcId: string;
	readonly terminals: readonly LiveTerminalInput[];
	readonly statusSince: LiveStatusSince;
	readonly alive: boolean;
	readonly now: number;
}): LiveMemory {
	const base = previous.pcId === input.pcId ? previous : { ...EMPTY_LIVE_MEMORY, pcId: input.pcId };
	const agents = input.terminals.filter(terminal => terminal.agent === true);
	const starting = !input.alive && agents.some(terminal => isActiveKind(agentStatusKind(terminal.agentStatus)));
	const working = new Map<string, { readonly start?: number }>();
	const finished = new Map(starting ? [] : base.finished);
	const present = new Set(agents.map(terminal => terminal.terminalKey));
	for (const key of finished.keys()) {
		if (!present.has(key)) {
			finished.delete(key);
		}
	}
	for (const terminal of agents) {
		const key = terminal.terminalKey;
		const kind = agentStatusKind(terminal.agentStatus);
		const before = base.working.get(key);
		if (isActiveKind(kind)) {
			// 要対応と実行中を行き来しても、同じ作業として始まりの時刻を保つ。
			const since = sinceOf(input.statusSince, terminal);
			working.set(key, before ?? (since !== undefined && kind === 'running' ? { start: since } : {}));
			finished.delete(key);
			continue;
		}
		if (kind === 'review' && before !== undefined) {
			const at = sinceOf(input.statusSince, terminal) ?? input.now;
			finished.set(key, { at, ...(before.start !== undefined ? { took: Math.max(0, at - before.start) } : {}) });
			continue;
		}
		if (kind !== 'review') {
			finished.delete(key);
		}
	}
	return { pcId: input.pcId, working, finished };
}

function isActiveKind(kind: string): boolean {
	return kind === 'attention' || kind === 'running';
}

// ---------------------------------------------------------------------------
// 中身の組み立て

function firstLine(text: string | undefined, max: number): string | undefined {
	return clampText(text?.split('\n').find(line => line.trim().length > 0), max);
}

/**
 * 要対応の中身（ツール名と、コマンドまたは質問文）。会話を開いたことのないエージェントは
 * 手元に写しが無いので出せない（無しにする）。
 */
export function attentionDetail(kind: 'permission' | 'question', chat: LiveChatInput | undefined): { tool?: string; detail?: string } {
	if (chat === undefined || chat.none === true) {
		return {};
	}
	if (kind === 'permission') {
		const interaction = chat.interaction;
		if (interaction !== undefined && interaction.kind === 'approval') {
			const tool = firstLine(interaction.title, LIVE_TOOL_MAX);
			const detail = firstLine(interaction.detail, LIVE_DETAIL_MAX);
			return { ...(tool !== undefined ? { tool } : {}), ...(detail !== undefined ? { detail } : {}) };
		}
		const live = chat.live;
		if (live !== undefined && live.phase === 'permission') {
			const tool = firstLine(live.tool, LIVE_TOOL_MAX);
			const detail = firstLine(live.detail, LIVE_DETAIL_MAX);
			return { ...(tool !== undefined ? { tool } : {}), ...(detail !== undefined ? { detail } : {}) };
		}
		return {};
	}
	if (chat.interaction !== undefined && chat.interaction.kind === 'question') {
		const detail = firstLine(chat.interaction.title ?? chat.interaction.detail, LIVE_DETAIL_MAX);
		if (detail !== undefined) {
			return { detail };
		}
	}
	const messages = chat.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message !== undefined && message.kind === 'question') {
			const detail = firstLine(message.text, LIVE_DETAIL_MAX);
			return detail !== undefined ? { detail } : {};
		}
	}
	return {};
}

/** 実行中のツールと対象（`agentRowLine` と同じく、ツールを動かしている間だけ）。 */
export function runningTool(chat: LiveChatInput | undefined): { tool?: string; target?: string } {
	const live = chat === undefined || chat.none === true ? undefined : chat.live;
	if (live === undefined || live.phase !== 'tool') {
		return {};
	}
	const tool = firstLine(live.tool, LIVE_TOOL_MAX);
	if (tool === undefined) {
		return {};
	}
	const target = firstLine(live.detail, LIVE_TARGET_MAX);
	return { tool, ...(target !== undefined ? { target } : {}) };
}

/** 時刻の分かるものを先に、古い順（長く待たせているものが先頭）。同じなら元の並び。 */
function byOldest<T extends { readonly since?: number }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => (a.since ?? Number.MAX_SAFE_INTEGER) - (b.since ?? Number.MAX_SAFE_INTEGER));
}

/** 時刻の分かるものを先に、新しい順。同じなら元の並び。 */
function byNewest<T extends { readonly since?: number }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => (b.since ?? Number.MIN_SAFE_INTEGER) - (a.since ?? Number.MIN_SAFE_INTEGER));
}

function nameOf(terminal: LiveTerminalInput): string {
	return clampText(terminal.title, LIVE_NAME_MAX) ?? 'エージェント';
}

/**
 * いまの状態から中身を作る（PC に繋がっているときだけ呼ぶ）。
 * phase は、要対応があれば attention、実行中だけなら running、どちらも無ければ done。
 */
export function buildLiveActivityState(input: {
	readonly terminals: readonly LiveTerminalInput[];
	readonly chats: ReadonlyMap<string, LiveChatInput>;
	readonly statusSince: LiveStatusSince;
	readonly memory: LiveMemory;
	readonly battery?: { readonly level: number; readonly charging: boolean };
	/**
	 * 質問文とコマンド（ツール名を含む）を載せるか。設定 → ウィジェットの「質問文とコマンドを表示」
	 * （`src/widgets/settings.ts` の `showDetail`）に従う。オフならロック画面にも出さない。
	 */
	readonly includeDetail: boolean;
	readonly now: number;
}): LiveActivityState {
	const agents = input.terminals.filter(terminal => terminal.agent === true);
	const waiting = byOldest(agents
		.filter(terminal => agentStatusKind(terminal.agentStatus) === 'attention')
		.map(terminal => ({ terminal, since: sinceOf(input.statusSince, terminal) })));
	const running = byNewest(agents
		.filter(terminal => agentStatusKind(terminal.agentStatus) === 'running')
		.map(terminal => ({ terminal, since: sinceOf(input.statusSince, terminal) })));
	const reviewKeys = new Set(agents.filter(terminal => agentStatusKind(terminal.agentStatus) === 'review').map(terminal => terminal.terminalKey));
	const byKey = new Map(agents.map(terminal => [terminal.terminalKey, terminal]));
	const finished = [...input.memory.finished.entries()]
		.filter(([key]) => reviewKeys.has(key))
		.sort((a, b) => b[1].at - a[1].at);

	const attention = waiting.slice(0, LIVE_ATTENTION_MAX).map(({ terminal, since }, index): LiveActivityAttentionItem => {
		const kind = terminal.agentStatus === 'question' ? 'question' : 'permission';
		// 2件目は「次」として名前だけを出すので、中身は先頭の1件だけに載せる（4KB の節約）。
		const detail = index === 0 && input.includeDetail ? attentionDetail(kind, input.chats.get(terminal.terminalKey)) : {};
		return {
			key: terminal.terminalKey,
			...(terminal.ws !== undefined ? { space: terminal.ws } : {}),
			name: nameOf(terminal),
			kind,
			...(since !== undefined ? { since } : {}),
			...detail,
		};
	});
	const runningItems = running.slice(0, LIVE_RUNNING_MAX).map(({ terminal, since }): LiveActivityRunningItem => ({
		key: terminal.terminalKey,
		...(terminal.ws !== undefined ? { space: terminal.ws } : {}),
		name: nameOf(terminal),
		...(since !== undefined ? { since } : {}),
		...runningTool(input.chats.get(terminal.terminalKey)),
	}));
	const done = finished.slice(0, LIVE_DONE_MAX).flatMap(([key, entry]): LiveActivityDoneItem[] => {
		const terminal = byKey.get(key);
		if (terminal === undefined) {
			return [];
		}
		return [{
			key,
			...(terminal.ws !== undefined ? { space: terminal.ws } : {}),
			name: nameOf(terminal),
			at: entry.at,
			...(entry.took !== undefined ? { took: entry.took } : {}),
		}];
	});
	return {
		phase: waiting.length > 0 ? 'attention' : running.length > 0 ? 'running' : 'done',
		waitingCount: waiting.length,
		runningCount: running.length,
		doneCount: finished.length,
		attention,
		running: runningItems,
		done,
		...(input.battery !== undefined ? { battery: { level: Math.round(input.battery.level), charging: input.battery.charging } } : {}),
		updatedAt: input.now,
	};
}

/** 要対応の質問文とコマンド（ツール名を含む）を外す。設定でオフにしたときに、前に出した中身へ当てる。 */
export function withoutAttentionDetail(state: LiveActivityState): LiveActivityState {
	if (state.attention.every(item => item.tool === undefined && item.detail === undefined)) {
		return state;
	}
	return { ...state, attention: state.attention.map(({ tool: _tool, detail: _detail, ...item }) => item) };
}

/**
 * PC に繋がらないときの中身。直前の中身をそのまま灰色で見せ、PC を最後に見た時刻を添える
 * （件数や名前を消さない。何が止まっているかは分かったままにする）。
 */
export function toOfflineState(last: LiveActivityState, lastSeenAt: number | undefined, now: number): LiveActivityState {
	const { asOf: _asOf, endsAt: _endsAt, ...rest } = last;
	return { ...rest, phase: 'offline', updatedAt: now, ...(lastSeenAt !== undefined ? { asOf: lastSeenAt } : {}) };
}

// ---------------------------------------------------------------------------
// PC に繋がらない状態の見張り

/** 繋がらなくなった時刻を進める（繋がっていれば無し）。 */
export function nextUnreachableSince(previous: number | undefined, reachable: boolean, now: number): number | undefined {
	return reachable ? undefined : previous ?? now;
}

/** オフラインと見なすか（繋がらない状態が猶予を超えて続いた）。 */
export function isOfflineConfirmed(unreachableSince: number | undefined, now: number): boolean {
	return unreachableSince !== undefined && now - unreachableSince >= LIVE_OFFLINE_GRACE_MS;
}

// ---------------------------------------------------------------------------
// 出す・終える判断

export type LiveMode =
	/** 出していない。 */
	| { readonly kind: 'none' }
	/** 出している（更新できる）。 */
	| { readonly kind: 'active'; readonly pcId: string }
	/** 完了の要約を載せて終えた。`until` までロック画面に残っている。 */
	| { readonly kind: 'finished'; readonly pcId: string; readonly until: number };

export type LiveAction =
	| { readonly kind: 'keep' }
	| { readonly kind: 'show'; readonly state: LiveActivityState }
	| { readonly kind: 'finish'; readonly state: LiveActivityState; readonly dismissAt: number }
	| { readonly kind: 'end' };

/**
 * 出している（または完了の要約を残している）Live Activity が、いま見ている PC とは別の PC のものか。
 * 繋がらない PC へ切り替えたときは中身を作れないので、前の PC のものをここで見つけて終える。
 */
export function isShownForOtherPc(mode: LiveMode, pcId: string): boolean {
	return mode.kind !== 'none' && mode.pcId !== pcId;
}

/**
 * 中身と今の出し方から、次にすることを決める。
 *
 * - 要対応・実行中: 出す（無ければ始める）
 * - オフライン: 出している間だけ灰色にする（オフラインだけのために始めない）
 * - 完了: 出していたなら、終わったものがあれば要約を載せて終え、最長 15 分残す。無ければすぐ消す。
 *   要約を残している間に全部確認された（未確認でなくなった）ら、その時点で消す
 */
export function decideLiveActivity(mode: LiveMode, state: LiveActivityState, pcId: string, now: number): { readonly action: LiveAction; readonly mode: LiveMode } {
	switch (state.phase) {
		case 'attention':
		case 'running':
			return { action: { kind: 'show', state }, mode: { kind: 'active', pcId } };
		case 'offline':
			return mode.kind === 'active' ? { action: { kind: 'show', state }, mode } : { action: { kind: 'keep' }, mode };
		case 'done': {
			if (mode.kind === 'active') {
				if (state.doneCount > 0 && mode.pcId === pcId) {
					const dismissAt = now + LIVE_DONE_LINGER_MS;
					return { action: { kind: 'finish', state: { ...state, endsAt: dismissAt }, dismissAt }, mode: { kind: 'finished', pcId, until: dismissAt } };
				}
				return { action: { kind: 'end' }, mode: { kind: 'none' } };
			}
			if (mode.kind === 'finished') {
				if (now >= mode.until) {
					// システムが消し終えている。
					return { action: { kind: 'keep' }, mode: { kind: 'none' } };
				}
				if (mode.pcId !== pcId || state.doneCount === 0) {
					return { action: { kind: 'end' }, mode: { kind: 'none' } };
				}
			}
			return { action: { kind: 'keep' }, mode };
		}
	}
}

// ---------------------------------------------------------------------------
// 4KB に収める・送り直しの比較

function utf8Length(text: string): number {
	let bytes = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			// サロゲートペアは2つで4バイト。
			bytes += 4;
			index++;
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

/** 静的属性と中身を合わせた JSON のバイト数。 */
export function liveActivityBytes(attributes: LiveActivityAttributes, state: LiveActivityState): number {
	return utf8Length(JSON.stringify(attributes)) + utf8Length(JSON.stringify(state));
}

const SHRINK_STEPS: readonly ((state: LiveActivityState) => LiveActivityState)[] = [
	// 実行中の対象（ファイルのパス）は無くても形が崩れない。
	state => ({ ...state, running: state.running.map(({ target: _target, ...item }) => item) }),
	// コマンド・質問文を短くする。
	state => ({ ...state, attention: state.attention.map(item => item.detail !== undefined ? { ...item, detail: clampText(item.detail, 32) ?? item.detail } : item) }),
	// 完了は1件だけにする（件数は doneCount に残る）。
	state => ({ ...state, done: state.done.slice(0, 1) }),
	// 名前を短くする。
	state => ({
		...state,
		attention: state.attention.map(item => ({ ...item, name: clampText(item.name, 16) ?? item.name })),
		running: state.running.map(item => ({ ...item, name: clampText(item.name, 16) ?? item.name })),
		done: state.done.map(item => ({ ...item, name: clampText(item.name, 16) ?? item.name })),
	}),
	// それでも収まらなければ、先頭の1件ずつにする。
	state => ({ ...state, attention: state.attention.slice(0, 1), running: state.running.slice(0, 1), done: [] }),
];

/** 上限（`LIVE_ACTIVITY_MAX_BYTES`）に収まるまで、目立たない所から削る。 */
export function fitLiveActivityBudget(attributes: LiveActivityAttributes, state: LiveActivityState, maxBytes = LIVE_ACTIVITY_MAX_BYTES): LiveActivityState {
	let current = state;
	for (const shrink of SHRINK_STEPS) {
		if (liveActivityBytes(attributes, current) <= maxBytes) {
			return current;
		}
		current = shrink(current);
	}
	return current;
}

/** 送り直すかどうかの比較に使う鍵（時刻だけが進む `updatedAt` を除く）。 */
export function liveActivityContentKey(attributes: LiveActivityAttributes, state: LiveActivityState): string {
	return JSON.stringify({ attributes, state: { ...state, updatedAt: 0 } });
}

/** 静的属性（PC）。名前は上限で切る。 */
export function liveActivityAttributes(pcId: string, pcName: string): LiveActivityAttributes {
	return { pcId, pcName: clampText(pcName, LIVE_NAME_MAX) ?? 'PC' };
}
