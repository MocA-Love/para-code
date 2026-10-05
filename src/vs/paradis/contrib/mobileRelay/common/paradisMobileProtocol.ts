/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code Mobile の共有プロトコル（PC側の移植）。
//
// **重要**: このファイルは `app/protocol`（モバイル/リレーが使う @noble 実装）と
// **ワイヤ互換**でなければならない。フレーム/ペアリング/リレーの各コーデックは依存ゼロなので
// app/protocol からほぼ逐語移植している。暗号（AES-256-GCM + X25519 + HKDF-SHA256）は
// vscode本体へ新規npm依存を持ち込まないため Node/Web の webcrypto で実装する
// （app/protocol/test/interop.test.ts が @noble ↔ webcrypto のバイト互換を保証している）。
// app/protocol 側を変更したら必ずこちらも更新し interop テストを通すこと。

// ---- チャネル定義（app/protocol/src/frames.ts と一致） ----

export const Channels = Object.freeze({
	State: 'state',
	Terminal: 'term',
	Scm: 'scm',
	Fs: 'fs',
	Browser: 'browser',
	Notify: 'notify',
	Agent: 'agent',
} as const);

export type ChannelId = typeof Channels[keyof typeof Channels];

const CHANNEL_TO_ID: Record<ChannelId, number> = { state: 1, term: 2, scm: 3, fs: 4, browser: 5, notify: 6, agent: 7 };
const ID_TO_CHANNEL = new Map<number, ChannelId>((Object.entries(CHANNEL_TO_ID) as [ChannelId, number][]).map(([ch, id]) => [id, ch]));

export interface Frame {
	readonly ch: ChannelId;
	readonly ws?: string;
	readonly seq: number;
	readonly payload: Uint8Array;
	/** 続きのチャンクがある（版 3 までの分割。受け取りだけ残す。FrameMuxが再結合する）。 */
	readonly more?: boolean;
	/** 版 4 の断片（送信 ID・何番目か・最後か）。FrameMux が送信 ID ごとに組み立て直す。 */
	readonly frag?: FrameFragment;
}

/** 版 4 の断片の見出し（app/protocol/src/frames.ts と一致）。 */
export interface FrameFragment {
	/** 送信 ID（送り手ごとに採番。u32）。 */
	readonly id: number;
	/** 何番目か（0 始まり。u32）。 */
	readonly index: number;
	/** 最後の断片か。 */
	readonly last: boolean;
}

/** flags の bit2: 版 4 の断片の見出しがある。bit3: 最後の断片。 */
const FLAG_FRAGMENT = 0x04;
const FLAG_FRAGMENT_LAST = 0x08;
const FRAGMENT_HEADER_BYTES = 8;

export function encodeFrame(frame: Frame): Uint8Array {
	const chId = CHANNEL_TO_ID[frame.ch];
	if (chId === undefined) {
		throw new Error(`unknown frame channel: ${String(frame.ch)}`);
	}
	if (!Number.isSafeInteger(frame.seq) || frame.seq < 0 || frame.seq > 0xffffffff) {
		throw new Error('frame seq out of range');
	}
	const wsBytes = frame.ws !== undefined ? new TextEncoder().encode(frame.ws) : new Uint8Array(0);
	if (wsBytes.length > 0xffff) {
		throw new Error('frame ws too long');
	}
	const frag = frame.frag;
	if (frag !== undefined && (!Number.isSafeInteger(frag.id) || frag.id < 0 || frag.id > 0xffffffff || !Number.isSafeInteger(frag.index) || frag.index < 0 || frag.index > 0xffffffff)) {
		throw new Error('frame fragment out of range');
	}
	const fragBytes = frag !== undefined ? FRAGMENT_HEADER_BYTES : 0;
	const out = new Uint8Array(8 + wsBytes.length + fragBytes + frame.payload.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, chId);
	view.setUint8(1, (frame.ws !== undefined ? 0x01 : 0x00) | (frame.more === true ? 0x02 : 0x00)
		| (frag !== undefined ? FLAG_FRAGMENT : 0x00) | (frag?.last === true ? FLAG_FRAGMENT_LAST : 0x00));
	view.setUint32(2, frame.seq, false);
	view.setUint16(6, wsBytes.length, false);
	out.set(wsBytes, 8);
	// 断片の見出しは ws の後ろに置く（版 3 の受け手が ws を読み違えないように）
	if (frag !== undefined) {
		view.setUint32(8 + wsBytes.length, frag.id, false);
		view.setUint32(8 + wsBytes.length + 4, frag.index, false);
	}
	out.set(frame.payload, 8 + wsBytes.length + fragBytes);
	return out;
}

export function decodeFrame(bytes: Uint8Array): Frame {
	if (bytes.length < 8) {
		throw new Error('malformed frame: too short');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ch = ID_TO_CHANNEL.get(view.getUint8(0));
	if (ch === undefined) {
		throw new Error(`unknown frame channel id: ${view.getUint8(0)}`);
	}
	const flags = view.getUint8(1);
	const hasWs = (flags & 0x01) !== 0;
	const more = (flags & 0x02) !== 0;
	const seq = view.getUint32(2, false);
	const wsLen = view.getUint16(6, false);
	if (8 + wsLen > bytes.length) {
		throw new Error('malformed frame: ws length exceeds buffer');
	}
	const ws = hasWs ? new TextDecoder().decode(bytes.subarray(8, 8 + wsLen)) : undefined;
	let frag: FrameFragment | undefined;
	let payloadStart = 8 + wsLen;
	if ((flags & FLAG_FRAGMENT) !== 0) {
		if (payloadStart + FRAGMENT_HEADER_BYTES > bytes.length) {
			throw new Error('malformed frame: fragment header exceeds buffer');
		}
		frag = { id: view.getUint32(payloadStart, false), index: view.getUint32(payloadStart + 4, false), last: (flags & FLAG_FRAGMENT_LAST) !== 0 };
		payloadStart += FRAGMENT_HEADER_BYTES;
	}
	const payload = bytes.subarray(payloadStart);
	return {
		ch,
		seq,
		payload,
		...(ws !== undefined ? { ws } : {}),
		...(more ? { more: true } : {}),
		...(frag !== undefined ? { frag } : {}),
	};
}

/** mobile が renderer provider に維持させる dashboard warm lease。 */
export type ParadisMobileWarmLeaseRequest = Readonly<{
	readonly t: 'usageWarmLease' | 'spaceDiskWarmLease';
	readonly leaseId: string;
	readonly active: boolean;
	readonly desktopEpoch: string;
	readonly windowId: number;
	readonly rendererGeneration: number;
}>;

export type ParadisMobileWarmLeaseParseResult =
	| { readonly kind: 'not-warm' }
	| { readonly kind: 'invalid' }
	| { readonly kind: 'valid'; readonly request: ParadisMobileWarmLeaseRequest };

const PARADIS_MOBILE_WARM_LEASE_KEYS = ['active', 'desktopEpoch', 'leaseId', 'rendererGeneration', 't', 'windowId'] as const;
const PARADIS_MOBILE_WARM_LEASE_ID = /^[A-Za-z0-9._:-]{1,96}$/;

/**
 * warm lease だけを通常の protocol v3 FS/SCM request から切り分け、exact plain payload を検証する。
 * 通常 request は rendererGeneration を持たない既存 wire のままなので、not-warm として返す。
 */
export function parseParadisMobileWarmLeaseRequest(value: unknown): ParadisMobileWarmLeaseParseResult {
	if (value === null || typeof value !== 'object') {
		return { kind: 'not-warm' };
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.t !== 'usageWarmLease' && candidate.t !== 'spaceDiskWarmLease') {
		return { kind: 'not-warm' };
	}
	if (Object.getPrototypeOf(candidate) !== Object.prototype
		|| Object.keys(candidate).sort().join('\0') !== [...PARADIS_MOBILE_WARM_LEASE_KEYS].sort().join('\0')
		|| typeof candidate.leaseId !== 'string' || !PARADIS_MOBILE_WARM_LEASE_ID.test(candidate.leaseId)
		|| typeof candidate.active !== 'boolean'
		|| typeof candidate.desktopEpoch !== 'string' || candidate.desktopEpoch.length === 0 || candidate.desktopEpoch.length > 200
		|| typeof candidate.windowId !== 'number' || !Number.isSafeInteger(candidate.windowId) || candidate.windowId < 0
		|| typeof candidate.rendererGeneration !== 'number' || !Number.isSafeInteger(candidate.rendererGeneration) || candidate.rendererGeneration < 1) {
		return { kind: 'invalid' };
	}
	return { kind: 'valid', request: candidate as ParadisMobileWarmLeaseRequest };
}

/** warm lease JSON bytes を判別する。JSON 不正は通常 request と同じく配送しない。 */
export function decodeParadisMobileWarmLeaseRequest(bytes: Uint8Array): ParadisMobileWarmLeaseParseResult {
	try {
		return parseParadisMobileWarmLeaseRequest(JSON.parse(new TextDecoder().decode(bytes)));
	} catch {
		return { kind: 'not-warm' };
	}
}

// ---- リレー制御メッセージ（app/protocol/src/relay.ts と一致） ----

export const RELAY_DATA_VERSION = 0x01;
export const MOBILE_ID_LENGTH = 16;

export type RelayControlMessage =
	| { readonly type: 'pairing-msg'; readonly data: string; readonly pairId?: string }
	| { readonly type: 'pairing-approve'; readonly pairId: string; readonly name: string }
	| { readonly type: 'pairing-reject'; readonly pairId: string }
	| { readonly type: 'paired'; readonly deviceId: string; readonly mobileId: string; readonly mobileToken: string }
	| { readonly type: 'presence'; readonly peer: 'pc' | 'mobile'; readonly mobileId?: string; readonly online: boolean }
	| { readonly type: 'error'; readonly message: string }
	// APNsプッシュ: モバイルがトークンを登録し（register-push）、PCがオフラインのモバイル宛に
	// 暗号文ペイロード（通知鍵で封緘済み・リレーは復号不可）のプッシュ配送を依頼する（push-notify）
	| { readonly type: 'register-push'; readonly token: string; readonly env?: 'prod' | 'dev' }
	//
	// collapseId / threadId は任意（旧PCは送らない。旧リレーは読まずに無視する）。どちらも
	// リレーとAPNsから見えるので、**中身から推測できない値**（通知鍵を知る者だけが作れる
	// HMAC等）でなければならない。collapseId は `apns-collapse-id`（同じ値の通知は端末上で
	// 置き換わる）、threadId は `aps.thread-id`（通知センターでまとまる）になる。
	// 形式は PARADIS_PUSH_ID_PATTERN。外れた値はリレーが黙って捨てる（プッシュ自体は送る）。
	// threadId は aps.thread-id として平文で出るので、同じスペースの通知どうしの紐付けはリレーと Apple に見える。
	// requestId（push.ack.v1）を付けると、リレーは依頼を書き留めてから push-ack を返し、同じ requestId の送り直しを
	// APNs へ二重に送らない。旧リレーは読まずに無視する（push-ack も返さない）。
	| { readonly type: 'push-notify'; readonly mobileId: string; readonly payload: string; readonly collapseId?: string; readonly threadId?: string; readonly requestId?: string }
	// リレー→PC: requestId 付きの push-notify を受理した（accepted）／形が悪く送れない（rejected）。どちらでも outbox から外す
	| { readonly type: 'push-ack'; readonly requestId: string; readonly result: 'accepted' | 'rejected' }
	// リレー→PC: モバイル自身がペアリングを解除した（self-revoke）。PCは登録一覧から取り除く
	| { readonly type: 'mobile-revoked'; readonly mobileId: string }
	// 保活。pingにはリレーのDurable Objectを起こさずエッジが自動応答する（setWebSocketAutoResponse）
	| { readonly type: 'ping' }
	| { readonly type: 'pong' };

/**
 * 保活メッセージの正準表現。リレー側の自動応答はバイト列の完全一致で照合するため、
 * `encodeRelayControl({ type: 'ping' })` の出力とこの定数は一致していなければならない。
 */
export const PARADIS_RELAY_KEEPALIVE_PING = '{"type":"ping"}';
export const PARADIS_RELAY_KEEPALIVE_PONG = '{"type":"pong"}';

/** push-notify の collapseId / threadId として受け付ける形（base64url 8〜64文字）。 */
export const PARADIS_PUSH_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * リレーがモバイルのWebSocketを閉じるときの理由コード（PCは使わないが、複製を揃えておく）。
 * 資格を認めないモバイルを upgrade 前の HTTP 401 ではなく、受理してからこのコードで閉じる。
 * どちらも再ペアリングだけが解決策。
 */
export const PARADIS_RELAY_CLOSE_CODE = Object.freeze({
	CREDENTIAL_REFUSED: 4401,
	UNKNOWN_MOBILE: 4404,
	/** PC からの失効。アプリは認証拒否として扱うが、リレーはまだ送らない（今は 4404 で閉じる）。 */
	REVOKED: 4410,
} as const);

export function encodeRelayControl(message: RelayControlMessage): string {
	return JSON.stringify(message);
}

export function decodeRelayControl(text: string): RelayControlMessage {
	const raw = JSON.parse(text) as { type?: unknown };
	if (raw === null || typeof raw !== 'object' || typeof raw.type !== 'string') {
		throw new Error('malformed relay control message');
	}
	return raw as RelayControlMessage;
}

export function packPcData(mobileId: Uint8Array, payload: Uint8Array): Uint8Array {
	if (mobileId.length !== MOBILE_ID_LENGTH) {
		throw new Error(`mobileId must be ${MOBILE_ID_LENGTH} bytes`);
	}
	const out = new Uint8Array(1 + MOBILE_ID_LENGTH + payload.length);
	out[0] = RELAY_DATA_VERSION;
	out.set(mobileId, 1);
	out.set(payload, 1 + MOBILE_ID_LENGTH);
	return out;
}

export function unpackPcData(bytes: Uint8Array): { mobileId: Uint8Array; payload: Uint8Array } {
	if (bytes.length < 1 + MOBILE_ID_LENGTH || bytes[0] !== RELAY_DATA_VERSION) {
		throw new Error('malformed relay data message');
	}
	return { mobileId: bytes.subarray(1, 1 + MOBILE_ID_LENGTH), payload: bytes.subarray(1 + MOBILE_ID_LENGTH) };
}

// ---- base64url（app/protocol/src/util.ts と一致） ----

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i] ?? 0;
		const b1 = bytes[i + 1];
		const b2 = bytes[i + 2];
		out += BASE64URL[b0 >> 2];
		out += BASE64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
		if (b1 !== undefined) { out += BASE64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]; }
		if (b2 !== undefined) { out += BASE64URL[b2 & 0x3f]; }
	}
	return out;
}

export function fromBase64Url(text: string): Uint8Array {
	const len = text.length;
	if (len % 4 === 1) {
		throw new Error('invalid base64url length');
	}
	const out = new Uint8Array(Math.floor((len * 3) / 4));
	let outPos = 0;
	let buffer = 0;
	let bits = 0;
	for (let i = 0; i < len; i++) {
		const idx = BASE64URL.indexOf(text[i]!);
		if (idx < 0) {
			throw new Error(`invalid base64url character at ${i}`);
		}
		buffer = (buffer << 6) | idx;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[outPos++] = (buffer >> bits) & 0xff;
		}
	}
	return out.subarray(0, outPos);
}

export function mobileIdToString(mobileId: Uint8Array): string {
	return toBase64Url(mobileId);
}

export function mobileIdFromString(text: string): Uint8Array {
	const bytes = fromBase64Url(text);
	if (bytes.length !== MOBILE_ID_LENGTH) {
		throw new Error('invalid mobileId');
	}
	return bytes;
}

// ---- ペアリングペイロード（app/protocol/src/pairing.ts と一致） ----

export const PAIRING_URI_SCHEME = 'paracode-mobile://pair';

export interface PairingPayload {
	readonly version: 1;
	readonly relayUrl: string;
	readonly deviceId: string;
	readonly pairId: string;
	readonly pairingToken: Uint8Array;
	readonly pcPublicKey: Uint8Array;
	/**
	 * このPCの表示名（省略可）。モバイルが複数のPCとペアリングしたときに一覧で見分けるために送る。
	 * 旧アプリはこのフィールドを無視する。
	 */
	readonly pcName?: string;
}

/** ペアリングURIへ載せるPC名の上限。QRの情報量を増やしすぎないための切り詰め。 */
export const PAIRING_PC_NAME_MAX_LENGTH = 64;

// ---- notify チャネルのペイロード（app/protocol/src/notify.ts と一致） ----

export type NotifyKind = 'agent-question' | 'agent-done' | 'agent-error' | 'disconnected';

/** バナーを出さないでほしい理由（NotifyPayload.quiet）。 */
export type ParadisNotifyQuiet = 'muted' | 'pushed';

export interface NotifyPayload {
	readonly kind: NotifyKind;
	readonly id: string;
	/**
	 * 通知タイトル。ワークツリー（スペース）の名前を入れる。
	 * iOSが太字で出すのはここだけなので、「どこで待たれているか」以外を混ぜない。
	 */
	readonly title: string;
	/**
	 * タイトルの下に細く出す一行。エージェント種別（例: "Claude"）を入れる。
	 * 種別が分からない経路（状態遷移から出る通知）ではターミナル名が入る。
	 * **PC名はここに含めない**（`pcName` を参照）。
	 */
	readonly subtitle?: string;
	readonly body: string;
	readonly ws?: string;
	readonly terminalId?: number;
	readonly terminalKey?: string;
	readonly windowId?: number;
	readonly agentToken?: string;
	/**
	 * 送信元PCの識別子（リレー上の deviceId）と表示名。`dispatchNotifyNow` が全ての通知へ
	 * 一括で刻む。封緘の中に入るのでリレーからは見えず、差し替えもできない。
	 */
	readonly pcId?: string;
	readonly pcName?: string;
	readonly at: number;
	/**
	 * 「通知一覧には入れるが、バナーは出さないでほしい」印（`paradisNotifyDelivery.ts`）。
	 * 省略時はモバイルが自分で鳴らす（この印を知らない旧PCからのフレームは従来どおり鳴る）。
	 * - `muted`: 鳴らす必要が無い（種別オフ、PC操作中）。モバイルは必ず従う
	 * - `pushed`: PCがAPNsプッシュを送ったので二重に鳴らさないでほしい。ただしPCはプッシュの
	 *   成否を知らないので、プッシュを受け取れないと分かっている端末（トークン未登録・通知
	 *   許可なし）は自分で鳴らしてよい
	 */
	readonly quiet?: ParadisNotifyQuiet;
	/**
	 * もう片付いた通知の印（W2-27。プッシュの暗号文にだけ載せる。`app/protocol/src/notify.ts` と一致）。
	 * 通知 ID を通知鍵から用途別に作った鍵で HMAC にした16進32桁で、作るのは `node/paradisMobilePushIds.ts`、
	 * どれを載せるかは `paradisNotifyDismissLedger.ts`。
	 */
	readonly dismiss?: readonly string[];
	/**
	 * 通知の種類（`notify.content.v1`。iOS のカテゴリ `para.<種類>`）。これが付いた通知は、受け取る側が
	 * `agent` と `tab` から副題を組み立て直す（`paradisNotifyCompose.ts`）。旧アプリは読まずに `subtitle` を使う。
	 */
	readonly category?: 'done' | 'approval' | 'question' | 'error';
	/** 送り主のエージェント（副題と、iOS の Communication Notification の送り主のアイコン）。 */
	readonly agent?: 'claude' | 'codex';
	/** タブ名（エージェントの印を外したもの。副題に使う）。 */
	readonly tab?: string;
	/** 長押しの画面に出す Markdown の原文（「通知に内容を含める」がオンのときだけ）。 */
	readonly detail?: string;
	/** 承認・質問の ID（通知のボタンで答えるとき、同じ確認かを確かめるため）。 */
	readonly interactionId?: string;
}

export function encodeNotify(payload: NotifyPayload): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(payload));
}

/**
 * 配送の判断と、既読になった通知の取り消しに必要な項目だけをNotifyペイロードから読む。
 * 形式不正なら全て undefined（呼び出し側は「鳴らす」側に倒す）。
 */
export interface IParadisNotifyMeta {
	readonly kind: NotifyKind | undefined;
	readonly id: string | undefined;
	readonly agentToken: string | undefined;
}

export function peekNotifyMeta(bytes: Uint8Array): IParadisNotifyMeta {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { kind?: unknown; id?: unknown; agentToken?: unknown };
		const kind = parsed.kind;
		return {
			kind: kind === 'agent-question' || kind === 'agent-done' || kind === 'agent-error' || kind === 'disconnected' ? kind : undefined,
			id: typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : undefined,
			agentToken: typeof parsed.agentToken === 'string' && parsed.agentToken.length > 0 ? parsed.agentToken : undefined,
		};
	} catch {
		return { kind: undefined, id: undefined, agentToken: undefined };
	}
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

// W2-27: アプリは1件ずつの `dismiss` に `opened: true` を付ける（「すべて消去」では付けない）。上の読み手は
// この項目を落とすので、PC は `paradisNotifyDismissLedger.ts` の `paradisNotifyDismissOpened` で読む。
//
// W2-34 の notify チャネルの `visibility` / `visibility-ack`（アプリが裏に回った・前面に戻った）は、
// `paradisMobileVisibility.ts` に `app/protocol/src/notify.ts` から逐語で写してある（上の制御メッセージの
// 読み手はどちらも `t` を知らないものとして捨てる）。

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

export function encodePairingUri(payload: PairingPayload): string {
	const pcName = payload.pcName?.trim().slice(0, PAIRING_PC_NAME_MAX_LENGTH);
	const json = JSON.stringify({
		v: payload.version,
		r: payload.relayUrl,
		d: payload.deviceId,
		p: payload.pairId,
		t: toBase64Url(payload.pairingToken),
		k: toBase64Url(payload.pcPublicKey),
		...(pcName ? { n: pcName } : {}),
	});
	return `${PAIRING_URI_SCHEME}?d=${toBase64Url(new TextEncoder().encode(json))}`;
}
