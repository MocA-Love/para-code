// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { decodeUtf8 } from './utf8.js';

/**
 * `notify` チャネル（PC→モバイル）のペイロード定義とコーデック。
 * エージェント（Claude Code / Codex）の質問・完了・エラーや接続断をモバイルへ知らせる。
 *
 * オンライン時は E2E チャネル上でそのまま届く。オフライン時は同じ暗号化ペイロードを
 * リレー経由で APNs へ送る（設計書 §5.2）。ここではペイロードの形と JSON コーデックのみ定義する。
 */

export type NotifyKind = 'agent-question' | 'agent-done' | 'agent-error' | 'disconnected';

/** バナーを出さないでほしい理由（NotifyPayload.quiet）。 */
export type NotifyQuiet = 'muted' | 'pushed';

export interface NotifyPayload {
	readonly kind: NotifyKind;
	/** 一意なID（重複表示の抑制・タップ時のディープリンクに使う）。 */
	readonly id: string;
	/**
	 * 通知タイトル。ワークツリー（スペース）の名前を入れる。
	 * iOSが太字で出すのはここだけなので、「どこで待たれているか」以外を混ぜない。
	 */
	readonly title: string;
	/**
	 * タイトルの下に細く出す一行。エージェント種別（例: "Claude"）を入れる。
	 * 種別が分からない経路（PCの状態遷移から出る通知）ではターミナル名が入る。
	 *
	 * **PC名はここに含めない**。何台のPCとペアリングしているかは受け取る側しか知らないため、
	 * 2台以上のときだけ `pcName` を継ぎ足すのは受信側（NSE・アプリ）の役目になる。
	 */
	readonly subtitle?: string;
	/** 本文（例: 質問文の要約）。 */
	readonly body: string;
	/** 関連ワークスペースの状態キー（あればディープリンク先）。 */
	readonly ws?: string;
	/** 関連ターミナルのインスタンスID（あればディープリンク先）。 */
	readonly terminalId?: number;
	/** 関連ターミナルの再起動をまたぐ論理ID（ディープリンクの正規キー）。 */
	readonly terminalKey?: string;
	readonly windowId?: number;
	readonly agentToken?: string;
	/**
	 * 送信元PCの識別子（リレー上の deviceId ＝ モバイル台帳の `PairedPc.id`）と表示名。
	 * PCが封緘の中で名乗るので、リレーからは見えず差し替えもできない。
	 *
	 * 通知拡張（NSE）は本来「復号できた鍵がどのPCのものか」で送信元を決めるが、そちらは
	 * Keychainの項目名を読める場合にしか使えない。読めなかったときの拠り所としてここを使う。
	 */
	readonly pcId?: string;
	readonly pcName?: string;
	/** PC側で通知が発生した時刻（epoch ms）。 */
	readonly at: number;
	/**
	 * 「通知一覧には入れるが、バナーは出さないでほしい」印。
	 * 省略時は自分で鳴らす（この印を知らない旧PCからのフレームは従来どおり鳴る）。
	 * - `muted`: 鳴らす必要が無い（種別オフ、PC操作中）。必ず従う
	 * - `pushed`: PCがAPNsプッシュを送ったので二重に鳴らさないでほしい。ただしPCはプッシュの
	 *   成否を知らないので、プッシュを受け取れないと分かっている端末は自分で鳴らしてよい
	 */
	readonly quiet?: NotifyQuiet;
	/**
	 * もう片付いた通知の印（W2-27。**プッシュの暗号文にだけ載る**）。PC が片付いたと知っている通知
	 * （スマホで開いた・PC で確認済みにしたエージェントの確認より前の通知）の `id` を、通知鍵から用途別に
	 * 作った鍵で HMAC-SHA256 にした16進先頭32桁。通知拡張（NSE）が同じ値を作って通知センターから消す。
	 * PC は10件まで載せる。旧アプリ・旧 NSE は読まずに無視する。
	 */
	readonly dismiss?: readonly string[];
}

/** `dismiss` の1件の形（16進32桁）と、読む件数の上限。 */
const NOTIFY_DISMISS_TAG_PATTERN = /^[0-9a-f]{32}$/;
const NOTIFY_DISMISS_MAX_TAGS = 32;

export function encodeNotify(payload: NotifyPayload): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(payload));
}

export function decodeNotify(bytes: Uint8Array): NotifyPayload {
	const raw = JSON.parse(decodeUtf8(bytes)) as Record<string, unknown>;
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
	const subtitle = typeof raw['subtitle'] === 'string' && raw['subtitle'].length > 0 && raw['subtitle'].length <= 100 ? raw['subtitle'] : undefined;
	const pcId = typeof raw['pcId'] === 'string' && raw['pcId'].length > 0 && raw['pcId'].length <= 200 ? raw['pcId'] : undefined;
	const pcName = typeof raw['pcName'] === 'string' && raw['pcName'].length > 0 && raw['pcName'].length <= 100 ? raw['pcName'] : undefined;
	const ws = typeof raw['ws'] === 'string' ? raw['ws'] : undefined;
	const terminalId = typeof raw['terminalId'] === 'number' ? raw['terminalId'] : undefined;
	const terminalKey = typeof raw['terminalKey'] === 'string' && raw['terminalKey'].length > 0 && raw['terminalKey'].length <= 200 ? raw['terminalKey'] : undefined;
	const windowId = typeof raw['windowId'] === 'number' && Number.isInteger(raw['windowId']) ? raw['windowId'] : undefined;
	const agentToken = typeof raw['agentToken'] === 'string' && raw['agentToken'].length <= 200 ? raw['agentToken'] : undefined;
	const quiet = raw['quiet'] === 'muted' || raw['quiet'] === 'pushed' ? raw['quiet'] : undefined;
	const dismissRaw = raw['dismiss'];
	const dismiss = Array.isArray(dismissRaw)
		? dismissRaw.slice(0, NOTIFY_DISMISS_MAX_TAGS).filter((tag): tag is string => typeof tag === 'string' && NOTIFY_DISMISS_TAG_PATTERN.test(tag))
		: undefined;
	return { kind, id, title, body, at, ...(dismiss !== undefined && dismiss.length > 0 ? { dismiss } : {}), ...(subtitle !== undefined ? { subtitle } : {}), ...(ws !== undefined ? { ws } : {}), ...(terminalId !== undefined ? { terminalId } : {}), ...(terminalKey !== undefined ? { terminalKey } : {}), ...(windowId !== undefined ? { windowId } : {}), ...(agentToken !== undefined ? { agentToken } : {}), ...(pcId !== undefined ? { pcId } : {}), ...(pcName !== undefined ? { pcName } : {}), ...(quiet !== undefined ? { quiet } : {}) };
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

/**
 * `opened`（任意）: その通知を ID で指定して開いた・消した（W2-27）。PC はこれが付いた許可・質問だけを、
 * ほかの端末のロック画面から消してよい通知として扱う。「すべて消去」では付けない。旧PCは読まずに無視する。
 */
export function encodeNotifyDismiss(id: string, options?: { readonly opened?: boolean }): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ t: 'dismiss', id, ...(options?.opened === true ? { opened: true } : {}) }));
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
		const raw = JSON.parse(decodeUtf8(bytes)) as { t?: unknown; id?: unknown; token?: unknown };
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

/**
 * アプリが裏に回った・前面に戻ったことを PC へ伝える（W2-34。notify チャネル M→PC）と、その確認（PC→M）。
 *
 * アプリは裏に回ったとき、PC がこの知らせを受けて確認を返したときだけ、ソケットを最大30秒保つ。
 * 受けた PC は、そのスマホを「前面ではない」とみなし、最後に受信した時刻に関わらずプッシュを送る
 * （鳴らすかは PC が決める、の方針を保つため。paradisNotifyDelivery.ts）。旧PCはこの `t` を知らず
 * 確認を返さないので、アプリは今までどおり即座に閉じる。PC は `conn.background-grace.v1` を広告する。
 *
 * `id` は確認と突き合わせるためのもの（任意。前面の知らせには付けない）。
 */
export type NotifyVisibilityState = 'background' | 'foreground';

export type NotifyVisibilityMessage =
	| { readonly t: 'visibility'; readonly state: NotifyVisibilityState; readonly id?: string }
	| { readonly t: 'visibility-ack'; readonly state: NotifyVisibilityState; readonly id?: string };

const VISIBILITY_ID_MAX_LENGTH = 64;

export function encodeNotifyVisibility(state: NotifyVisibilityState, id?: string): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ t: 'visibility', state, ...(id !== undefined ? { id } : {}) }));
}

export function encodeNotifyVisibilityAck(state: NotifyVisibilityState, id?: string): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ t: 'visibility-ack', state, ...(id !== undefined ? { id } : {}) }));
}

/** notify チャネルの受信バイト列を W2-34 の知らせとして読む。違えば undefined。 */
export function decodeNotifyVisibility(bytes: Uint8Array): NotifyVisibilityMessage | undefined {
	try {
		const raw = JSON.parse(decodeUtf8(bytes)) as { t?: unknown; state?: unknown; id?: unknown };
		if ((raw.t !== 'visibility' && raw.t !== 'visibility-ack') || (raw.state !== 'background' && raw.state !== 'foreground')) {
			return undefined;
		}
		const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= VISIBILITY_ID_MAX_LENGTH ? raw.id : undefined;
		return { t: raw.t, state: raw.state, ...(id !== undefined ? { id } : {}) };
	} catch {
		return undefined;
	}
}
