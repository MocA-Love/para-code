// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * `notify` チャネル（PC→モバイル）のペイロード定義とコーデック。
 * エージェント（Claude Code / Codex）の質問・完了・エラーや接続断をモバイルへ知らせる。
 *
 * オンライン時は E2E チャネル上でそのまま届く。オフライン時は同じ暗号化ペイロードを
 * リレー経由で APNs へ送る（設計書 §5.2）。ここではペイロードの形と JSON コーデックのみ定義する。
 */

export type NotifyKind = 'agent-question' | 'agent-done' | 'agent-error' | 'disconnected';

export interface NotifyPayload {
	readonly kind: NotifyKind;
	/** 一意なID（重複表示の抑制・タップ時のディープリンクに使う）。 */
	readonly id: string;
	/** 通知タイトル（例: "Claude Code — para-code"）。 */
	readonly title: string;
	/** 本文（例: 質問文の要約）。 */
	readonly body: string;
	/** 関連ワークスペースの状態キー（あればディープリンク先）。 */
	readonly ws?: string;
	/** 関連ターミナルのインスタンスID（あればディープリンク先）。 */
	readonly terminalId?: number;
	readonly agentToken?: string;
	/** PC側で通知が発生した時刻（epoch ms）。 */
	readonly at: number;
}

export function encodeNotify(payload: NotifyPayload): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(payload));
}

export function decodeNotify(bytes: Uint8Array): NotifyPayload {
	const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
	if (raw === null || typeof raw !== 'object') {
		throw new Error('malformed notify payload');
	}
	const kind = raw['kind'];
	const id = raw['id'];
	const title = raw['title'];
	const body = raw['body'];
	const at = raw['at'];
	if (typeof kind !== 'string' || !isNotifyKind(kind) || typeof id !== 'string' || typeof title !== 'string' || typeof body !== 'string' || typeof at !== 'number') {
		throw new Error('malformed notify payload fields');
	}
	const ws = typeof raw['ws'] === 'string' ? raw['ws'] : undefined;
	const terminalId = typeof raw['terminalId'] === 'number' ? raw['terminalId'] : undefined;
	const agentToken = typeof raw['agentToken'] === 'string' && raw['agentToken'].length <= 200 ? raw['agentToken'] : undefined;
	return { kind, id, title, body, at, ...(ws !== undefined ? { ws } : {}), ...(terminalId !== undefined ? { terminalId } : {}), ...(agentToken !== undefined ? { agentToken } : {}) };
}

function isNotifyKind(value: string): value is NotifyKind {
	return value === 'agent-question' || value === 'agent-done' || value === 'agent-error' || value === 'disconnected';
}

/**
 * notify チャネル上の制御メッセージ（NotifyPayloadとは別形。`t` フィールドで区別する）。
 * - dismiss: モバイルが通知一覧で項目をタップ/クリアした（M→PC）。
 * - dismissed: PCが他の端末へ「その通知は既に処理された」ことを伝える（PC→M、複数端末間の一覧同期用）。
 * - dismissed-token: PC自身でペインを確認済みにした（acknowledgePaneStatus）ことを全モバイルへ
 *   伝える（PC→M）。dismissedと異なり通知の`id`をPC側は持たないため、代わりに`agentToken`で
 *   同一エージェントの通知をまとめて既読にする。
 */
export type NotifyControlMessage =
	| { readonly t: 'dismiss'; readonly id: string }
	| { readonly t: 'dismissed'; readonly id: string }
	| { readonly t: 'dismissed-token'; readonly token: string };

export function encodeNotifyDismiss(id: string): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ t: 'dismiss', id }));
}

export function encodeNotifyDismissed(id: string): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ t: 'dismissed', id }));
}

export function encodeNotifyDismissedByToken(token: string): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ t: 'dismissed-token', token }));
}

/**
 * notify チャネルの受信バイト列を制御メッセージとして読む。NotifyPayload（`kind`を持つ）や
 * 形式不正なバイト列に対しては undefined を返す（呼び出し側は通常のNotifyPayloadとしての
 * デコードにフォールバックする）。
 */
export function decodeNotifyControl(bytes: Uint8Array): NotifyControlMessage | undefined {
	try {
		const raw = JSON.parse(new TextDecoder().decode(bytes)) as { t?: unknown; id?: unknown; token?: unknown };
		if ((raw.t === 'dismiss' || raw.t === 'dismissed') && typeof raw.id === 'string') {
			return { t: raw.t, id: raw.id };
		}
		if (raw.t === 'dismissed-token' && typeof raw.token === 'string') {
			return { t: raw.t, token: raw.token };
		}
		return undefined;
	} catch {
		return undefined;
	}
}
