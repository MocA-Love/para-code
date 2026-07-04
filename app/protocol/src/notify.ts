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
	return { kind, id, title, body, at, ...(ws !== undefined ? { ws } : {}), ...(terminalId !== undefined ? { terminalId } : {}) };
}

function isNotifyKind(value: string): value is NotifyKind {
	return value === 'agent-question' || value === 'agent-done' || value === 'agent-error' || value === 'disconnected';
}
