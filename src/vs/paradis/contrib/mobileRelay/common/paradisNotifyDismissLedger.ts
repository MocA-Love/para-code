/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 片付いた通知を、次に届くプッシュでロック画面から消してもらう（W2-27、Q119 A）。
//
// PC で確認済みにした・別のスマホで開いた通知は、オンラインのスマホにしか知らせていない
// （`dismissed` / `dismissed-token`）。裏にいるスマホのロック画面には、アプリを開くまで残る。
// サイレントプッシュ（リレーの変更とネイティブ部品の追加が要り、iOS が間引く）の代わりに、
// 次に送る通常のプッシュの暗号文へ「もう消してよい通知」の印を入れ、通知拡張（NSE）が届いた時点で消す。
// 次の通知が来るまでは消えないが、リレーの変更は要らない。
//
// **消してよいのは PC が片付いたと知っているものだけ:**
// - スマホがその通知を ID を指定して開いた・消した（`dismiss` に `opened: true`。通知 ID で1件）。
//   許可・質問（`agent-question`）はこれでだけ消す
// - スマホが一覧を「すべて消去」した（`opened` の無い `dismiss`）: 完了などの通知だけ。許可・質問は消さない
//   （旧アプリは1件ずつの操作にも `opened` を付けないので、旧アプリからの許可・質問は消さない側に倒れる）
// - PC がそのエージェントのペインを確認済みにした、またはターミナルが終わった（`onDidAcknowledgePane`）:
//   確認した時刻より前に出した、許可・質問以外の通知だけ
// 状態（working など）からは推測しない（hook が来ないと状態が残り、未回答でも消してしまう）。
//
// 片付けは番号（seq）付きの出来事として台帳に積み、ディスクへ残す（Q242 A。`paradis-mobile-notify-dismiss.json`）。
// スマホは繋がったときに「最後に受け取った番号」を送り、それより後の片付けを受け取って一覧と通知センターから消す
// （`dismiss-sync` / `dismiss-log`。`notify.dismiss-sync.v1`）。PC を再起動しても、次のプッシュの印も続けて載る。
// 許可・質問は、回答が成立したと PC が知ったとき（hook の PostToolUse などがその ID で来た・ターンが終わった）にも
// 片付ける（Q241 A・Q243 A）。PC で見ただけでは片付けない。

/** 1回のプッシュに載せる印の数の上限（APNs の 4KB に収めるため）。 */
export const PARADIS_NOTIFY_DISMISS_MAX_IDS = 10;
/** これより前に片付いたものは載せない（ロック画面に1日以上残っているものは、アプリを開いたときの同期に任せる）。 */
export const PARADIS_NOTIFY_DISMISS_TTL_MS = 24 * 60 * 60 * 1000;
/** 覚えておく通知の数（出した通知・片付いた通知の合計。Q224 A の 200 件）。 */
export const PARADIS_NOTIFY_DISMISS_LEDGER_LIMIT = 200;
/** 覚えておく期間（Q224 A の 7 日）。出した時刻と片付いた時刻の新しいほうから数える。 */
export const PARADIS_NOTIFY_DISMISS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const FILE_VERSION = 1;
const LEDGER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_ID_LENGTH = 200;

interface IEmitted {
	readonly id: string;
	/** エージェントトークンを {@link IParadisNotifyDismissLedgerOptions.tokenKey} で変換したもの（ディスクにはこれだけ書く）。 */
	readonly tokenKey: string | undefined;
	/** 通知の種別（分からなければ undefined。許可・質問として扱う）。 */
	readonly kind: string | undefined;
	/** 承認・質問の ID（notify.content.v1）。回答が成立したかを突き合わせる。 */
	readonly interactionId: string | undefined;
	readonly at: number;
	handledAt: number | undefined;
	/** 片付いた出来事の番号（片付いていなければ undefined）。 */
	seq: number | undefined;
}

/** 許可・質問（未回答かもしれない）か。種別が分からないものも、消さない側に倒してこちらに入れる。 */
function isPrompt(kind: string | undefined): boolean {
	return kind === undefined || kind === 'agent-question';
}

export interface IParadisNotifyDismissLedgerOptions {
	/**
	 * エージェントトークンを台帳に残す形へ変える（既定はそのまま）。トークンは PC の MCP 接続に使う値なので、
	 * PC は鍵付きのハッシュを渡し、ディスクには生のトークンを書かない。
	 */
	readonly tokenKey?: (token: string) => string;
	/** 台帳の ID を作る（既定は UUID）。台帳を作り直したら番号を数え直したことを、スマホが ID の違いで知る。 */
	readonly newLedgerId?: () => string;
}

/** スマホへ返す、ある番号より後の片付け（`dismiss-log`）。 */
export interface IParadisNotifyDismissLog {
	readonly ledger: string;
	/** 台帳のいまの番号（スマホは次からこれを送る）。 */
	readonly seq: number;
	/** 片付いた通知 ID（古い順）。 */
	readonly ids: readonly string[];
}

export class ParadisNotifyDismissLedger {

	/** 出した順（古い順）。 */
	private readonly entries: IEmitted[] = [];
	private seq = 0;
	private ledgerIdValue: string;
	private readonly tokenKey: (token: string) => string;

	constructor(options: IParadisNotifyDismissLedgerOptions = {}) {
		this.tokenKey = options.tokenKey ?? (token => token);
		this.ledgerIdValue = (options.newLedgerId ?? (() => globalThis.crypto.randomUUID()))();
	}

	get ledgerId(): string {
		return this.ledgerIdValue;
	}

	/** 通知を出した（プッシュ・フレームのどちらでも）。 */
	record(id: string, agentToken: string | undefined, kind: string | undefined, at: number, interactionId?: string): void {
		if (this.entries.some(entry => entry.id === id)) {
			return;
		}
		this.entries.push({ id, tokenKey: agentToken !== undefined ? this.tokenKey(agentToken) : undefined, kind, interactionId, at, handledAt: undefined, seq: undefined });
		this.trim(at);
	}

	/**
	 * スマホがその通知を消した。`opened` はその通知を ID で指定して開いた・消した（新しいアプリの1件ごとの
	 * 操作）。`opened` が無い（「すべて消去」・旧アプリ）ときは、許可・質問と、この PC が出したと
	 * 覚えていない通知（種別が分からない）は片付いたことにしない。新しく片付いた通知 ID を返す。
	 */
	markDismissed(id: string, at: number, opened: boolean): string[] {
		const entry = this.entries.find(candidate => candidate.id === id);
		if (entry !== undefined) {
			if (opened || !isPrompt(entry.kind)) {
				return this.settle(entry, at) ? [id] : [];
			}
			return [];
		}
		if (opened) {
			const added: IEmitted = { id, tokenKey: undefined, kind: undefined, interactionId: undefined, at, handledAt: undefined, seq: undefined };
			this.entries.push(added);
			this.settle(added, at);
			this.trim(at);
			return [id];
		}
		return [];
	}

	/**
	 * PC がそのエージェントのペインを確認済みにした。確認より前に出した同じエージェントの、許可・質問以外の通知が片付く
	 * （Q243 A。許可・質問は回答で片付ける）。新しく片付いた通知 ID を返す。
	 */
	markAcknowledged(agentToken: string, at: number): string[] {
		const key = this.tokenKey(agentToken);
		return this.settleWhere(at, entry => entry.tokenKey === key && entry.at < at && !isPrompt(entry.kind));
	}

	/**
	 * そのエージェントの許可・質問に、どこかで回答が成立した（Q241 A）。`interactionId` があればその ID の通知だけ、
	 * 無ければ（ターンが終わった・次の指示が来た）その時刻より前に出した許可・質問の全部が片付く。
	 * 新しく片付いた通知 ID を返す。
	 */
	markAnswered(agentToken: string, interactionId: string | undefined, at: number): string[] {
		const key = this.tokenKey(agentToken);
		return this.settleWhere(at, entry => entry.tokenKey === key && entry.kind === 'agent-question'
			&& (interactionId !== undefined ? entry.interactionId === interactionId : entry.at < at));
	}

	/** その通知がもう片付いたか（裏に回ったときのプッシュし直しで、片付いたものを送らないため）。 */
	isSettled(id: string | undefined): boolean {
		return id !== undefined && this.entries.some(entry => entry.id === id && entry.handledAt !== undefined);
	}

	/** 次のプッシュに載せる通知 ID（新しく片付いた順）。`except` はいま送る通知自身。 */
	dismissable(now: number, except?: string): string[] {
		return this.entries
			.filter(entry => entry.handledAt !== undefined && now - entry.handledAt <= PARADIS_NOTIFY_DISMISS_TTL_MS && entry.id !== except)
			.sort((a, b) => b.handledAt! - a.handledAt!)
			.slice(0, PARADIS_NOTIFY_DISMISS_MAX_IDS)
			.map(entry => entry.id);
	}

	/**
	 * `after` 番より後の片付け（スマホが繋がったときの同期）。スマホの覚えている台帳の ID が違えば（作り直した・
	 * 初めて）、覚えている全部を返す。
	 */
	since(ledger: string | undefined, after: number): IParadisNotifyDismissLog {
		const from = ledger === this.ledgerIdValue && Number.isInteger(after) && after >= 0 && after <= this.seq ? after : 0;
		const ids = this.entries
			.filter(entry => entry.seq !== undefined && entry.seq > from)
			.sort((a, b) => a.seq! - b.seq!)
			.map(entry => entry.id);
		return { ledger: this.ledgerIdValue, seq: this.seq, ids };
	}

	/** ディスクへ書く形（JSON）。 */
	serialize(now: number): string {
		this.trim(now);
		return JSON.stringify({
			v: FILE_VERSION,
			ledger: this.ledgerIdValue,
			seq: this.seq,
			entries: this.entries.map(entry => ({
				id: entry.id,
				...(entry.tokenKey !== undefined ? { tk: entry.tokenKey } : {}),
				...(entry.kind !== undefined ? { kind: entry.kind } : {}),
				...(entry.interactionId !== undefined ? { iid: entry.interactionId } : {}),
				at: entry.at,
				...(entry.handledAt !== undefined ? { h: entry.handledAt } : {}),
				...(entry.seq !== undefined ? { s: entry.seq } : {}),
			})),
		});
	}

	/**
	 * ディスクから読んだ台帳を取り込む。読み終わる前に起きた出来事（起動直後の通知・片付け）は消さず、
	 * 読んだ台帳の後ろへ番号を振り直して続ける。形の合わない項目は捨てる。読めなければ何もしない。
	 */
	restore(raw: string | undefined, now: number): void {
		const parsed = parseLedgerFile(raw);
		if (parsed === undefined) {
			return;
		}
		const pendingEntries = this.entries.splice(0, this.entries.length);
		this.ledgerIdValue = parsed.ledger;
		this.seq = parsed.seq;
		this.entries.push(...parsed.entries);
		for (const entry of pendingEntries) {
			const existing = this.entries.find(candidate => candidate.id === entry.id);
			if (existing === undefined) {
				const settled = entry.handledAt !== undefined;
				entry.seq = undefined;
				this.entries.push(entry);
				if (settled) {
					entry.seq = ++this.seq;
				}
			} else if (entry.handledAt !== undefined && existing.handledAt === undefined) {
				this.settle(existing, entry.handledAt);
			}
		}
		this.entries.sort((a, b) => a.at - b.at);
		this.trim(now);
	}

	private settle(entry: IEmitted, at: number): boolean {
		if (entry.handledAt !== undefined) {
			return false;
		}
		entry.handledAt = at;
		entry.seq = ++this.seq;
		return true;
	}

	private settleWhere(at: number, predicate: (entry: IEmitted) => boolean): string[] {
		const settled: string[] = [];
		for (const entry of this.entries) {
			if (entry.handledAt === undefined && predicate(entry) && this.settle(entry, at)) {
				settled.push(entry.id);
			}
		}
		return settled;
	}

	private trim(now: number): void {
		for (let index = this.entries.length - 1; index >= 0; index--) {
			const entry = this.entries[index];
			if (entry !== undefined && now - Math.max(entry.at, entry.handledAt ?? 0) > PARADIS_NOTIFY_DISMISS_RETENTION_MS) {
				this.entries.splice(index, 1);
			}
		}
		if (this.entries.length > PARADIS_NOTIFY_DISMISS_LEDGER_LIMIT) {
			this.entries.splice(0, this.entries.length - PARADIS_NOTIFY_DISMISS_LEDGER_LIMIT);
		}
	}
}

function optionalText(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 台帳のファイルを読む。形が違えば undefined（作り直す）。 */
function parseLedgerFile(raw: string | undefined): { readonly ledger: string; readonly seq: number; readonly entries: IEmitted[] } | undefined {
	if (raw === undefined) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	if (record.v !== FILE_VERSION || typeof record.ledger !== 'string' || !LEDGER_ID_PATTERN.test(record.ledger)
		|| typeof record.seq !== 'number' || !Number.isInteger(record.seq) || record.seq < 0) {
		return undefined;
	}
	const seq = record.seq;
	const entries: IEmitted[] = [];
	const seen = new Set<string>();
	for (const item of Array.isArray(record.entries) ? record.entries.slice(-PARADIS_NOTIFY_DISMISS_LEDGER_LIMIT) : []) {
		if (typeof item !== 'object' || item === null) {
			continue;
		}
		const entry = item as Record<string, unknown>;
		const id = optionalText(entry.id);
		const at = finiteNumber(entry.at);
		if (id === undefined || at === undefined || seen.has(id)) {
			continue;
		}
		const handledAt = finiteNumber(entry.h);
		const entrySeq = typeof entry.s === 'number' && Number.isInteger(entry.s) && entry.s > 0 && entry.s <= seq ? entry.s : undefined;
		seen.add(id);
		entries.push({
			id,
			tokenKey: optionalText(entry.tk),
			kind: optionalText(entry.kind),
			interactionId: optionalText(entry.iid),
			at,
			// 片付いた時刻と番号はそろっているときだけ採る（片方だけでは同期に出せない）
			handledAt: handledAt !== undefined && entrySeq !== undefined ? handledAt : undefined,
			seq: handledAt !== undefined ? entrySeq : undefined,
		});
	}
	return { ledger: record.ledger, seq, entries };
}


/** スマホの `dismiss` が、その通知を ID で指定して開いた・消したものか（`opened: true`。旧アプリは付けない）。 */
export function paradisNotifyDismissOpened(bytes: Uint8Array): boolean {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { opened?: unknown } | null;
		return parsed !== null && typeof parsed === 'object' && parsed.opened === true;
	} catch {
		return false;
	}
}

/**
 * 通知の本文（JSON）に印を足す（プッシュ用。フレームには足さない）。印が無い・JSON として読めない
 * ときはそのまま返す。
 */
export function paradisWithNotifyDismiss(bytes: Uint8Array, tags: readonly string[]): Uint8Array {
	if (tags.length === 0) {
		return bytes;
	}
	try {
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> | null;
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return bytes;
		}
		return new TextEncoder().encode(JSON.stringify({ ...parsed, dismiss: tags }));
	} catch {
		return bytes;
	}
}

/** 回答の成立を示す hook の出来事（ID で 1 件）。 */
const ANSWER_BY_TOOL_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']);
/** そのエージェントがもう何も待っていないことを示す hook の出来事（ターンの終わり・次の指示・終了）。 */
const ANSWER_ALL_EVENTS = new Set(['Stop', 'StopFailure', 'agent-turn-complete', 'task_complete', 'UserPromptSubmit', 'SessionEnd']);

/**
 * hook の出来事が、そのエージェントの許可・質問への回答の成立を示すか（Q241 A・Q243 A）。PC のターミナル・スマホの
 * トーク・通知のボタンのどこで答えても、エージェントはこれらの hook を出す。`interactionId` が undefined のときは
 * 「その時刻より前の許可・質問の全部」。関係しない出来事は undefined。
 */
export function paradisNotifyAnswerFromHook(event: string, toolUseId: string | undefined): { readonly interactionId: string | undefined } | undefined {
	if (ANSWER_BY_TOOL_EVENTS.has(event)) {
		return toolUseId !== undefined && toolUseId.length > 0 ? { interactionId: toolUseId } : undefined;
	}
	return ANSWER_ALL_EVENTS.has(event) ? { interactionId: undefined } : undefined;
}

/** 通知の本文から承認・質問の ID を読む（無ければ undefined）。 */
export function paradisNotifyInteractionId(bytes: Uint8Array): string | undefined {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { interactionId?: unknown } | null;
		return parsed !== null && typeof parsed === 'object' ? optionalText(parsed.interactionId) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * スマホの `{ t: 'dismiss-sync', ledger?, after }`（notify.dismiss-sync.v1。`app/protocol/src/notify.ts` と一致）。
 * 形が違えば undefined。
 */
export function paradisDecodeNotifyDismissSync(bytes: Uint8Array): { readonly ledger: string | undefined; readonly after: number } | undefined {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { t?: unknown; ledger?: unknown; after?: unknown } | null;
		if (parsed === null || typeof parsed !== 'object' || parsed.t !== 'dismiss-sync') {
			return undefined;
		}
		const ledger = typeof parsed.ledger === 'string' && LEDGER_ID_PATTERN.test(parsed.ledger) ? parsed.ledger : undefined;
		const after = typeof parsed.after === 'number' && Number.isInteger(parsed.after) && parsed.after >= 0 ? parsed.after : 0;
		return { ledger, after };
	} catch {
		return undefined;
	}
}

/** PC の `{ t: 'dismiss-log', ledger, seq, ids }`。 */
export function paradisEncodeNotifyDismissLog(log: IParadisNotifyDismissLog): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ t: 'dismiss-log', ledger: log.ledger, seq: log.seq, ids: log.ids }));
}
