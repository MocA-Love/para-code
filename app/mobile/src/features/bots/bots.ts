// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * スマホの Bot の画面（`bots.page.v1`。PC 側は paradisBotsMobileProtocol.ts・paradisBotsMobileRequests.ts）の読み方と送り方。
 *
 * PC が `bots.page.v1` を広告していて、State に `bots` が届いているときだけ使う（設定 `paradis.bots.enabled` がオフの PC は
 * `bots` を送らない）。一覧は State の `bots`、項目・提案・ファイルは fs の要求で取る。Bot の問いへの答えはここに無い
 * （要対応の台帳の経路 `answerHumanAsk` を、台帳の鍵 `bot:<uid>.<eventId>` で呼ぶ）。
 *
 * 形は PC の型と同じ。PC のモジュールは型でも読まない（VS Code の土台まで型検査に入ってしまうため。humanAsks.ts と同じ）。
 */

/** State に載る Bot 1 つ（PC の `IParadisMobileBot`）。 */
export interface MobileBot {
	readonly id: string;
	readonly name: string;
	readonly agent: string;
	readonly modelId?: string;
	readonly effortId?: string;
	readonly permissionId?: string;
	readonly faceColor: BotFaceColor;
	readonly faceShape: BotFaceShape;
	readonly paused: boolean;
	readonly pinned: boolean;
	/** 要対応（PC の「あなたの番」）の数。 */
	readonly needsYou: number;
	readonly openItems: number;
	readonly openSuggestions: number;
	/** `stopped`・`idle`・`working`・`patrolling`（知らない値もそのまま）。 */
	readonly activity: string;
	readonly lastActivityAt: number;
}

export const BOT_FACE_COLORS = ['blue', 'teal', 'green', 'amber', 'pink', 'violet', 'red', 'orange'] as const;
export const BOT_FACE_SHAPES = ['circle', 'squircle', 'hex', 'blob', 'drop', 'penta'] as const;
export type BotFaceColor = typeof BOT_FACE_COLORS[number];
export type BotFaceShape = typeof BOT_FACE_SHAPES[number];

/** 項目の一覧の 1 行（PC の `IParadisMobileBotItemRow`）。 */
export interface BotItemRow {
	readonly uid: string;
	readonly number: number;
	readonly title: string;
	readonly status: string;
	/** 要対応（Bot の問いが待っている）。 */
	readonly waits: boolean;
	readonly snoozedUntil?: number;
	readonly lastActivityAt: number;
	readonly closedAt?: number;
}

export interface BotItemEvent {
	readonly id: number;
	readonly kind: string;
	readonly actor: string;
	readonly at: number;
	readonly text?: string;
	readonly from?: string;
	readonly to?: string;
	readonly note?: string;
	readonly until?: number;
}

export interface BotItemLink {
	readonly kind: string;
	readonly ref: string;
}

/** 項目のページ（PC の `paradisMobileBotItemPage` の形のうち、画面で使う欄）。 */
export interface BotItemPage extends BotItemRow {
	readonly botId: string;
	readonly description?: string;
	readonly doneMeans?: string;
	readonly closeNote?: string;
	/** 今の問いのイベント（台帳の鍵 `bot:<uid>.<eventId>` に使う）。 */
	readonly askEventId?: number;
	readonly links: readonly BotItemLink[];
	readonly events: readonly BotItemEvent[];
	/** 知らない状態の項目（読み取り専用）。 */
	readonly locked: boolean;
}

export interface BotSuggestion {
	readonly id: string;
	readonly title: string;
	readonly request: string;
	readonly state: string;
	readonly createdAt: number;
}

export type BotItemAction =
	| { readonly action: 'comment'; readonly text: string }
	| { readonly action: 'done' | 'cancel' | 'unsnooze' }
	| { readonly action: 'snooze'; readonly until: number };

/** 設定の変更（欄の名前は PC の update_bot と同じ）。 */
export interface BotChanges {
	readonly name?: string;
	readonly agent?: string;
	/** null は既定へ戻す。 */
	readonly permission?: string | null;
	readonly pinned?: boolean;
	readonly paused?: boolean;
}

export type BotUpdateOutcome =
	| { readonly kind: 'applied' }
	| { readonly kind: 'confirm'; readonly detail: string; readonly wider: boolean };

const MAX_BOTS = 50;
const MAX_ITEMS = 200;
const MAX_EVENTS = 100;
const MAX_SUGGESTIONS = 100;
const MAX_NAME = 64;
const MAX_TEXT = 20_000;
const MAX_FILE = 1_000_000;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function str(value: unknown, max: number): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number {
	const value_ = num(value);
	return value_ !== undefined && value_ > 0 ? Math.floor(value_) : 0;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return (value !== undefined ? { [key]: value } : {}) as { [P in K]?: V };
}

// ---- State --------------------------------------------------------------------------------------

function parseBot(value: unknown): MobileBot | undefined {
	const input = record(value);
	const id = str(input?.id, 200);
	const name = str(input?.name, MAX_NAME);
	if (input === undefined || id === undefined || name === undefined) {
		return undefined;
	}
	const faceColor = BOT_FACE_COLORS.find(color => color === input.faceColor) ?? 'blue';
	const faceShape = BOT_FACE_SHAPES.find(shape => shape === input.faceShape) ?? 'circle';
	return {
		id,
		name,
		agent: str(input.agent, 40) ?? 'claude',
		...optional('modelId', str(input.modelId, 200)),
		...optional('effortId', str(input.effortId, 200)),
		...optional('permissionId', str(input.permissionId, 200)),
		faceColor,
		faceShape,
		paused: input.paused === true,
		pinned: input.pinned === true,
		needsYou: count(input.needsYou),
		openItems: count(input.openItems),
		openSuggestions: count(input.openSuggestions),
		activity: str(input.activity, 40) ?? 'stopped',
		lastActivityAt: num(input.lastActivityAt) ?? 0,
	};
}

/** State の `bots`。配列でなければ undefined（届いていない）、壊れた 1 件だけを捨てる。同じ id は先の 1 件だけ。 */
export function parseMobileBots(value: unknown): MobileBot[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const seen = new Set<string>();
	const bots: MobileBot[] = [];
	for (const entry of value.slice(0, MAX_BOTS)) {
		const bot = parseBot(entry);
		if (bot !== undefined && !seen.has(bot.id)) {
			seen.add(bot.id);
			bots.push(bot);
		}
	}
	return bots;
}

/** ターミナルの行の `botId`。短い文字列でなければ undefined。 */
export function parseTerminalBotId(value: unknown): string | undefined {
	return str(value, 200);
}

/** 下書きを入力欄の書きかけの後ろへ足す（書きかけは消さない。PC の insertDraft と同じく空行を挟む）。 */
export function appendBotDraft(current: string, text: string): string {
	return current.trim().length === 0 ? text : `${current.replace(/\s+$/, '')}\n\n${text}`;
}

/** その Bot のペイン（State の `botId` が付いたターミナル）。 */
export function botPaneOf<T extends { readonly botId?: string }>(terminals: readonly T[], botId: string): T | undefined {
	return terminals.find(terminal => terminal.botId === botId);
}

/** PC の画面の節に並べる順（ピン留め → 台帳の順）と、一時停止中の Bot（畳む）。 */
export function botSectionRows(bots: readonly MobileBot[], query: string): { readonly active: MobileBot[]; readonly paused: MobileBot[] } {
	const needle = query.trim().toLowerCase();
	const matched = needle.length === 0 ? bots : bots.filter(bot => bot.name.toLowerCase().includes(needle));
	const ordered = [...matched.filter(bot => bot.pinned), ...matched.filter(bot => !bot.pinned)];
	return { active: ordered.filter(bot => !bot.paused), paused: ordered.filter(bot => bot.paused) };
}

/** 行の名前の下に出す今の様子（PC の帯の `paradisBotStatusLine` と同じ順。PC の「あなたの番」はスマホでは「要対応」）。 */
export function botStatusLine(bot: Pick<MobileBot, 'paused' | 'needsYou' | 'activity'>): string {
	if (bot.paused) {
		return '一時停止中';
	}
	if (bot.needsYou > 0) {
		return `${bot.needsYou} 件が要対応`;
	}
	switch (bot.activity) {
		case 'working': return '作業中';
		case 'patrolling': return '見回り中';
		case 'idle': return '待機中';
		default: return '起動していません';
	}
}

/** エージェントの呼び名。 */
export function botAgentLabel(agent: string): string {
	switch (agent) {
		case 'claude': return 'Claude Code';
		case 'codex': return 'Codex';
		case 'opencode': return 'OpenCode';
		case 'antigravity': return 'Antigravity';
		default: return agent;
	}
}

// ---- 項目 ---------------------------------------------------------------------------------------

/** 項目の状態の呼び名（PC の `paradisBotItemStatusLabel` と同じ。「あなたの番」はスマホでは「要対応」）。 */
export function botItemStatusLabel(status: string): string {
	switch (status) {
		case 'planned': return '予定';
		case 'working': return '進行中';
		case 'waiting': return '外の返事待ち';
		case 'needs_you': return '要対応';
		case 'done': return '完了';
		case 'canceled': return '取り消し';
		default: return status;
	}
}

export function isBotItemClosed(item: Pick<BotItemRow, 'status' | 'closedAt'>): boolean {
	return item.closedAt !== undefined || item.status === 'done' || item.status === 'canceled';
}

export interface BotItemGroups {
	readonly you: BotItemRow[];
	readonly working: BotItemRow[];
	readonly planned: BotItemRow[];
	readonly snoozed: BotItemRow[];
	readonly closed: BotItemRow[];
}

/** 項目のタブの群（PC の `paradisBotItemGroups` と同じ分け方。新しく動いた順）。 */
export function botItemGroups(rows: readonly BotItemRow[], now: number): BotItemGroups {
	const sorted = [...rows].sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.number - a.number);
	const groups: BotItemGroups = { you: [], working: [], planned: [], snoozed: [], closed: [] };
	for (const row of sorted) {
		if (isBotItemClosed(row)) {
			groups.closed.push(row);
		} else if (row.snoozedUntil !== undefined && row.snoozedUntil > now) {
			groups.snoozed.push(row);
		} else if (row.waits) {
			groups.you.push(row);
		} else if (row.status === 'planned') {
			groups.planned.push(row);
		} else {
			groups.working.push(row);
		}
	}
	return groups;
}

/** 台帳の鍵の頭（`bot:<uid>.`）。問いを聞き直すと `eventId` が変わるので、頭で探す。 */
export function botAskKeyPrefix(uid: string): string {
	return `bot:${uid}.`;
}

/** 台帳の 1 件のうち、その項目の問い（無ければ undefined）。 */
export function botAskFor<T extends { readonly key: string }>(asks: readonly T[], uid: string): T | undefined {
	const prefix = botAskKeyPrefix(uid);
	return asks.find(ask => ask.key.startsWith(prefix));
}

/** 記録 1 件の文（誰が何をしたか）。 */
export function botItemEventLine(event: BotItemEvent): string {
	const who = event.actor === 'owner' ? 'あなた' : event.actor === 'bot' ? 'Bot' : 'Para Code';
	switch (event.kind) {
		case 'made': return `${who}が作りました`;
		case 'edited': return `${who}が書き換えました`;
		case 'status': return `${who}が「${botItemStatusLabel(event.to ?? '')}」にしました${event.note !== undefined ? `: ${event.note}` : ''}`;
		case 'commented': return `${who}: ${event.text ?? ''}`;
		case 'linked': return `${who}がリンクを足しました`;
		case 'snoozed': return event.until !== undefined ? `${who}が後回しにしました` : `${who}が後回しを解きました`;
		default: return `${who}: ${event.kind}`;
	}
}

function parseItemRow(value: unknown): BotItemRow | undefined {
	const input = record(value);
	const uid = str(input?.uid, 200);
	const number = num(input?.number);
	const title = str(input?.title, 400);
	const status = str(input?.status, 40);
	if (input === undefined || uid === undefined || number === undefined || title === undefined || status === undefined) {
		return undefined;
	}
	return {
		uid,
		number,
		title,
		status,
		waits: input.waits === true,
		...optional('snoozedUntil', num(input.snoozedUntil)),
		lastActivityAt: num(input.lastActivityAt) ?? 0,
		...optional('closedAt', num(input.closedAt)),
	};
}

/** botItems の応答。形が違えば undefined。 */
export function parseBotItemsReply(value: unknown): BotItemRow[] | undefined {
	const input = record(value);
	if (!Array.isArray(input?.items)) {
		return undefined;
	}
	return input.items.slice(0, MAX_ITEMS).map(parseItemRow).filter((row): row is BotItemRow => row !== undefined);
}

/** botItemAct の応答（変わった後の行）。 */
export function parseBotItemActReply(value: unknown): BotItemRow | 'duplicate' | undefined {
	const input = record(value);
	if (input?.duplicate === true) {
		return 'duplicate';
	}
	return parseItemRow(input?.item);
}

function parseEvent(value: unknown): BotItemEvent | undefined {
	const input = record(value);
	const id = num(input?.id);
	const kind = str(input?.kind, 40);
	const at = num(input?.at);
	if (input === undefined || id === undefined || kind === undefined || at === undefined) {
		return undefined;
	}
	return {
		id,
		kind,
		actor: str(input.actor, 20) ?? 'system',
		at,
		...optional('text', str(input.text, MAX_TEXT)),
		...optional('from', str(input.from, 40)),
		...optional('to', str(input.to, 40)),
		...optional('note', str(input.note, MAX_TEXT)),
		...optional('until', num(input.until)),
	};
}

/** botItem の応答（項目のページ）。 */
export function parseBotItemReply(value: unknown): BotItemPage | undefined {
	const item = record(record(value)?.item);
	const row = parseItemRow(item === undefined ? undefined : { ...item, waits: item.status === 'needs_you' && record(item.ask) !== undefined });
	const botId = str(item?.botId, 200);
	if (item === undefined || row === undefined || botId === undefined) {
		return undefined;
	}
	const links = Array.isArray(item.links) ? item.links.map(record).flatMap(link => {
		const kind = str(link?.kind, 20);
		const ref = str(link?.ref, 2_000);
		return kind !== undefined && ref !== undefined ? [{ kind, ref }] : [];
	}) : [];
	const events = Array.isArray(item.events) ? item.events.slice(-MAX_EVENTS).map(parseEvent).filter((event): event is BotItemEvent => event !== undefined) : [];
	return {
		...row,
		botId,
		...optional('description', str(item.description, MAX_TEXT)),
		...optional('doneMeans', str(item.doneMeans, MAX_TEXT)),
		...optional('closeNote', str(item.closeNote, MAX_TEXT)),
		...optional('askEventId', num(record(item.ask)?.eventId)),
		links,
		events,
		locked: item.locked === true,
	};
}

function parseSuggestion(value: unknown): BotSuggestion | undefined {
	const input = record(value);
	const id = str(input?.id, 200);
	const title = str(input?.title, 400);
	const request = str(input?.request, MAX_TEXT);
	if (input === undefined || id === undefined || title === undefined || request === undefined) {
		return undefined;
	}
	return { id, title, request, state: str(input.state, 40) ?? 'open', createdAt: num(input.createdAt) ?? 0 };
}

/** botSuggestions の応答（開いている提案だけ）。 */
export function parseBotSuggestionsReply(value: unknown): BotSuggestion[] | undefined {
	const input = record(value);
	if (!Array.isArray(input?.suggestions)) {
		return undefined;
	}
	return input.suggestions.slice(0, MAX_SUGGESTIONS).map(parseSuggestion).filter((entry): entry is BotSuggestion => entry !== undefined && entry.state === 'open');
}

/** botSuggestionAct の応答。 */
export function parseBotSuggestionActReply(value: unknown): BotSuggestion | 'duplicate' | undefined {
	const input = record(value);
	return input?.duplicate === true ? 'duplicate' : parseSuggestion(input?.suggestion);
}

/** botFile の応答。`conflict` はほかの場所が書き換えていた（書いていない。`text` は今の中身）。 */
export function parseBotFileReply(value: unknown): { readonly text: string; readonly conflict: boolean } | 'duplicate' | undefined {
	const input = record(value);
	if (input?.duplicate === true) {
		return 'duplicate';
	}
	return typeof input?.text === 'string' && input.text.length <= MAX_FILE ? { text: input.text, conflict: input.conflict === true } : undefined;
}

/** botUpdate の応答。`duplicate` は前の送信で当たっている。 */
export function parseBotUpdateReply(value: unknown): BotUpdateOutcome | undefined {
	const input = record(value);
	if (input?.applied === true || input?.duplicate === true) {
		return { kind: 'applied' };
	}
	const detail = str(input?.detail, MAX_TEXT);
	return input?.needsConfirmation === true && detail !== undefined ? { kind: 'confirm', detail, wider: input.permission === 'wider' } : undefined;
}

// ---- 要求 ---------------------------------------------------------------------------------------

export const BOT_REQUEST_KINDS = Object.freeze({
	items: 'botItems',
	item: 'botItem',
	itemAct: 'botItemAct',
	suggestions: 'botSuggestions',
	suggestionAct: 'botSuggestionAct',
	file: 'botFile',
	update: 'botUpdate',
	open: 'botOpen',
});

/** スマホで読めるファイル（書けるのは MEMORY.md だけ）。 */
export const BOT_FILES = ['SOUL.md', 'MEMORY.md'] as const;
export type BotFile = typeof BOT_FILES[number];

export function botItemsRequest(botId: string) {
	return { t: BOT_REQUEST_KINDS.items, botId };
}

export function botItemRequest(uid: string) {
	return { t: BOT_REQUEST_KINDS.item, uid };
}

export function botItemActRequest(opId: string, uid: string, act: BotItemAction) {
	return { t: BOT_REQUEST_KINDS.itemAct, opId, uid, ...act };
}

export function botSuggestionsRequest(botId: string) {
	return { t: BOT_REQUEST_KINDS.suggestions, botId };
}

export function botSuggestionActRequest(opId: string, id: string, action: 'start' | 'dismiss') {
	return { t: BOT_REQUEST_KINDS.suggestionAct, opId, id, action };
}

export function botFileReadRequest(botId: string, path: BotFile) {
	return { t: BOT_REQUEST_KINDS.file, botId, path };
}

/** MEMORY.md を書く。`base` は開いたときの中身（PC が今の中身と違えば書かない）。 */
export function botFileWriteRequest(opId: string, botId: string, path: BotFile, text: string, base: string) {
	return { t: BOT_REQUEST_KINDS.file, botId, path, text, base, opId };
}

/** 設定の変更。エージェント・権限は、まず `confirmed` 無しで送って PC の確認の本文を受け取る。 */
export function botUpdateRequest(opId: string, botId: string, changes: BotChanges, confirmed: boolean) {
	return { t: BOT_REQUEST_KINDS.update, botId, changes, opId, ...(confirmed ? { confirmed: true } : {}) };
}

export function botOpenRequest(opId: string, botId: string) {
	return { t: BOT_REQUEST_KINDS.open, opId, botId };
}

/** 書き込みの opId（押し直しで同じ操作を 2 回当てない）。 */
export function newBotOpId(): string {
	return `bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 設定のタブで 1 つの欄を変えたときに送る変更（触った欄だけを送る。ほかの欄の今の値を一緒に送ると、権限の一覧が届いて
 * いない間に名前を変えただけで権限が既定に戻る）。規則は PC の `paradisBotSettingsChange` と同じ: 名前は前後の空白を落とし、
 * 空なら変えない。権限の `default` は既定（null）。エージェントを変えるときは権限を既定へ戻す（前のエージェントの権限は
 * 持ち越さない）。何も変わらなければ undefined。
 */
export function botFieldChange(bot: Pick<MobileBot, 'name' | 'agent' | 'permissionId'>, change: { readonly name: string } | { readonly agent: string } | { readonly permissionId: string }): BotChanges | undefined {
	if ('name' in change) {
		const name = change.name.trim();
		return name.length > 0 && name !== bot.name ? { name } : undefined;
	}
	if ('agent' in change) {
		return change.agent !== bot.agent ? { agent: change.agent, permission: null } : undefined;
	}
	const permission = change.permissionId === 'default' ? undefined : change.permissionId;
	const before = bot.permissionId === 'default' ? undefined : bot.permissionId;
	return permission !== before ? { permission: permission ?? null } : undefined;
}

/** エージェント・権限を変えるときは PC の確認の本文で確かめる（PC の update_bot と同じ）。 */
export function botChangesNeedConfirmation(changes: BotChanges): boolean {
	return changes.agent !== undefined || Object.prototype.hasOwnProperty.call(changes, 'permission');
}

/** 断られたときの文（PcReplyError の `code`）。 */
export function botRefusalText(code: string | undefined): string {
	switch (code) {
		case 'disabled': return 'PC で Bot がオフになっています';
		case 'not_found': return '見つかりませんでした（消えたか、閉じられています）';
		case 'item_closed': return 'この項目はもう閉じています';
		case 'read_only': return 'この項目は PC の新しい Para Code で書かれたため、ここでは変えられません';
		case 'item_changed': return 'ほかの場所で書き換わりました。開き直してください';
		case 'invalid': case 'invalid_argument': return '送れない内容でした';
		default: return 'PC に届きませんでした';
	}
}
