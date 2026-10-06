// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 「見た」通知を PC へ伝える片付けの預かりと、PC の片付けの台帳をどこまで受け取ったかの印（Q241 A・Q242 A）。
 *
 * PC ごとに 1 つのファイルへ残す（`notifyDismissOutboxStore.ts`）。中身は通知 ID と台帳の番号だけ。
 * - 預かり: この端末で開いた・消した通知のうち、PC が受け取ったと分かっていないもの。つながるたびに送り直す。
 *   PC が notify.dismiss-sync.v1 を持っていれば、同期の返事（`dismiss-log`）に載った時点で受け取ったと分かり外す。
 *   持っていない PC には今までどおり送り直し続ける（件数と期限で古い順に落とす）
 * - 印: 最後に受け取った `dismiss-log` の台帳の ID と番号。次につながったとき、それより後の片付けだけを受け取る
 *
 * 件数と期間の上限は PC の台帳と同じ 200 件・7 日（Q224 A）。
 */

export const NOTIFY_DISMISS_OUTBOX_LIMIT = 200;
export const NOTIFY_DISMISS_OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const LEDGER_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface NotifyDismissCursor {
	readonly ledger: string;
	readonly seq: number;
}

export interface NotifyDismissOutboxEntry {
	readonly id: string;
	/** その通知を ID で指定して開いた・消した（`opened: true` で送る）。「すべて消去」なら false。 */
	readonly opened: boolean;
	readonly at: number;
}

export interface NotifyDismissOutboxState {
	readonly cursor: NotifyDismissCursor | undefined;
	/** 古い順。 */
	readonly entries: readonly NotifyDismissOutboxEntry[];
}

export const EMPTY_NOTIFY_DISMISS_OUTBOX: NotifyDismissOutboxState = { cursor: undefined, entries: [] };

/** 期限切れを外し、件数を上限に収める（古いものから落とす）。 */
export function pruneNotifyDismissOutbox(state: NotifyDismissOutboxState, now: number): NotifyDismissOutboxState {
	const entries = state.entries.filter(entry => now - entry.at <= NOTIFY_DISMISS_OUTBOX_MAX_AGE_MS).slice(-NOTIFY_DISMISS_OUTBOX_LIMIT);
	return entries.length === state.entries.length ? state : { cursor: state.cursor, entries };
}

/** 預かりを足す（同じ ID は新しいほうで置き換えて後ろへ）。 */
export function addNotifyDismissOutbox(state: NotifyDismissOutboxState, entry: NotifyDismissOutboxEntry): NotifyDismissOutboxState {
	return pruneNotifyDismissOutbox({ cursor: state.cursor, entries: [...state.entries.filter(candidate => candidate.id !== entry.id), entry] }, entry.at);
}

/** PC が受け取ったと分かった・ほかで片付いた預かりを外す。 */
export function removeNotifyDismissOutbox(state: NotifyDismissOutboxState, ids: readonly string[]): NotifyDismissOutboxState {
	if (ids.length === 0) {
		return state;
	}
	const done = new Set(ids);
	const entries = state.entries.filter(entry => !done.has(entry.id));
	return entries.length === state.entries.length ? state : { cursor: state.cursor, entries };
}

export function serializeNotifyDismissOutbox(state: NotifyDismissOutboxState): string {
	return JSON.stringify({ v: 1, ...(state.cursor !== undefined ? { cursor: state.cursor } : {}), entries: state.entries });
}

/** ファイルの中身を読む。読めなければ空（同期は番号 0 から、つまり PC が覚えている全部を受け取り直す）。 */
export function parseNotifyDismissOutbox(raw: string | null | undefined, now: number): NotifyDismissOutboxState {
	if (raw === null || raw === undefined) {
		return EMPTY_NOTIFY_DISMISS_OUTBOX;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return EMPTY_NOTIFY_DISMISS_OUTBOX;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as { v?: unknown }).v !== 1) {
		return EMPTY_NOTIFY_DISMISS_OUTBOX;
	}
	const record = parsed as { cursor?: unknown; entries?: unknown };
	const rawCursor = record.cursor as { ledger?: unknown; seq?: unknown } | undefined;
	const cursor = rawCursor !== null && typeof rawCursor === 'object' && typeof rawCursor.ledger === 'string' && LEDGER_PATTERN.test(rawCursor.ledger)
		&& typeof rawCursor.seq === 'number' && Number.isInteger(rawCursor.seq) && rawCursor.seq >= 0
		? { ledger: rawCursor.ledger, seq: rawCursor.seq }
		: undefined;
	const entries: NotifyDismissOutboxEntry[] = [];
	for (const item of Array.isArray(record.entries) ? record.entries : []) {
		const entry = item as { id?: unknown; opened?: unknown; at?: unknown } | null;
		if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 200
			|| typeof entry.at !== 'number' || !Number.isFinite(entry.at) || entries.some(candidate => candidate.id === entry.id)) {
			continue;
		}
		entries.push({ id: entry.id, opened: entry.opened === true, at: entry.at });
	}
	return pruneNotifyDismissOutbox({ cursor, entries }, now);
}
