// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * APNs (Apple Push Notification service) クライアント。token-based認証 (ES256 JWT)。
 *
 * リレーはE2E暗号文を開けないため、通知本文は固定文言を表示しつつ、暗号文をカスタム
 * ペイロード `e` に載せる。iOS側のNotification Service Extensionが `e` を復号して本文を
 * 差し替える（復号失敗時は固定文言がそのまま出るフォールバック設計）。
 *
 * デプロイ前に必要なシークレット（`app/relay` で実行）:
 *   npx wrangler secret put APNS_KEY_P8    # AuthKey_XXXX.p8 のPEM文字列（-----BEGIN PRIVATE KEY----- 〜）
 *   npx wrangler secret put APNS_KEY_ID    # 10文字のKey ID
 *   npx wrangler secret put APNS_TEAM_ID   # 10文字のApple Developer Team ID
 *   npx wrangler secret put APNS_TOPIC     # バンドルID（例: ltd.paradis.paracode.mobile）
 * いずれか未設定の場合、push-notify は警告ログを出して無視される（開発環境で壊れない）。
 */

export interface ApnsEnv {
	readonly APNS_KEY_P8?: string;
	readonly APNS_KEY_ID?: string;
	readonly APNS_TEAM_ID?: string;
	readonly APNS_TOPIC?: string;
}

/**
 * ES256 JWTのメモリキャッシュ。APNsは20〜60分の有効期間を要求するため、45分間再利用する。
 * DOインスタンスのメモリに保持する（hibernationで消えても再生成されるだけで問題ない）。
 */
export interface ApnsJwtCache {
	token?: string;
	/** 発行時刻（epoch秒）。 */
	iat?: number;
}

const JWT_TTL_SECONDS = 45 * 60;
/** プッシュの有効期限（APNsがオフライン端末のために保持する時間）。再送しても延ばさない。 */
export const PUSH_EXPIRATION_SECONDS = 4 * 3600;

/**
 * トークンそのものが使えないことを示す 400 の理由。410 Unregistered と同じくトークンを捨てる。
 * 開発ビルドのトークンを本番へ送った場合もここに入るが、アプリは接続のたびに register-push で
 * 登録し直すので、正しい環境のトークンがすぐ戻る。
 */
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);

export type ApnsSendResult =
	| { readonly kind: 'sent' }
	/** シークレット未設定（開発環境）。 */
	| { readonly kind: 'skipped' }
	/** トークンが失効・不正。呼び出し側でトークンを削除する。 */
	| { readonly kind: 'drop-token'; readonly status: number; readonly reason: string }
	/** 一時的な失敗（429 / 5xx / 通信失敗 / 期限切れJWT）。retryAfterMs は APNs の Retry-After。 */
	| { readonly kind: 'retry'; readonly status: number | undefined; readonly reason: string; readonly retryAfterMs?: number }
	/** 再送しても直らない失敗（その他の 4xx、ペイロード不正など）。 */
	| { readonly kind: 'failed'; readonly status: number | undefined; readonly reason: string };

export interface ApnsNotification {
	/** APNsデバイストークン（16進）。 */
	readonly token: string;
	readonly env: 'prod' | 'dev';
	/** E2E暗号文（base64url文字列のまま載せる）。 */
	readonly payload: string;
	/**
	 * `apns-collapse-id`。同じ値の通知は端末上で置き換わる。PCが作る中身の推測できない値
	 * （PARADIS_PUSH_ID_PATTERN を満たすもの）だけを渡すこと。
	 */
	readonly collapseId?: string;
	/** `aps.thread-id`。通知センターでまとめる単位。collapseId と同じ条件。 */
	readonly threadId?: string;
	/** `apns-expiration`（epoch秒）。再送のたびに延ばさないよう最初の送信時刻から決めて渡す。 */
	readonly expiresAtSeconds?: number;
}

/**
 * 対象デバイスへAPNs通知を1件送信する（再送はしない。再送の判断は呼び出し側が持つ）。
 */
export async function sendApnsNotification(env: ApnsEnv, notification: ApnsNotification, cache: ApnsJwtCache): Promise<ApnsSendResult> {
	if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) {
		console.warn('[apns] secrets not configured; skipping push-notify');
		return { kind: 'skipped' };
	}

	let jwt: string;
	try {
		jwt = await getJwt(env, cache);
	} catch (err) {
		console.warn('[apns] failed to build auth JWT:', err);
		return { kind: 'failed', status: undefined, reason: 'jwt' };
	}

	const host = notification.env === 'dev' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
	const nowSeconds = Math.floor(Date.now() / 1000);
	const expiresAtSeconds = notification.expiresAtSeconds ?? nowSeconds + PUSH_EXPIRATION_SECONDS;
	const body = JSON.stringify({
		aps: {
			alert: { title: 'Para Code', body: '新しい通知があります' },
			sound: 'default',
			'mutable-content': 1,
			...(notification.threadId !== undefined ? { 'thread-id': notification.threadId } : {}),
		},
		e: notification.payload,
	});

	let res: Response;
	try {
		res = await fetch(`${host}/3/device/${notification.token}`, {
			method: 'POST',
			headers: {
				authorization: `bearer ${jwt}`,
				'apns-topic': env.APNS_TOPIC,
				'apns-push-type': 'alert',
				'apns-priority': '10',
				'apns-expiration': String(expiresAtSeconds),
				...(notification.collapseId !== undefined ? { 'apns-collapse-id': notification.collapseId } : {}),
			},
			body,
		});
	} catch (err) {
		console.warn('[apns] request failed:', err);
		return { kind: 'retry', status: undefined, reason: 'transport' };
	}

	if (res.ok) {
		return { kind: 'sent' };
	}
	const reason = await readReason(res);
	const result = classifyApnsFailure(res.status, reason, res.headers.get('retry-after'), Date.now());
	if (result.kind === 'retry' && reason === 'ExpiredProviderToken') {
		// 手元のJWTが古いと見なされた。次の送信で作り直させる。
		cache.token = undefined;
		cache.iat = undefined;
	}
	console.warn(`[apns] push rejected: ${res.status} ${reason}`);
	return result;
}

/**
 * APNs の失敗応答（200以外）を「トークンを捨てる / 再送する / 諦める」に振り分ける。
 * 純関数にしてあるので、状態コードと理由の組み合わせをテストで固定できる。
 */
export function classifyApnsFailure(status: number, reason: string, retryAfterHeader: string | null, nowMs: number): Exclude<ApnsSendResult, { kind: 'sent' } | { kind: 'skipped' }> {
	if (status === 410 || (status === 400 && DEAD_TOKEN_REASONS.has(reason))) {
		return { kind: 'drop-token', status, reason };
	}
	if (status === 429 || status >= 500 || (status === 403 && reason === 'ExpiredProviderToken')) {
		const retryAfterMs = parseRetryAfter(retryAfterHeader, nowMs);
		return { kind: 'retry', status, reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
	}
	return { kind: 'failed', status, reason };
}

/** Retry-After（秒数またはHTTP日付）をミリ秒へ。読めなければ undefined。 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
	if (value === null || value.trim() === '') {
		return undefined;
	}
	const seconds = Number(value);
	const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - nowMs;
	return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

async function readReason(res: Response): Promise<string> {
	try {
		const parsed = await res.json<{ reason?: unknown }>();
		return typeof parsed.reason === 'string' ? parsed.reason : 'unknown';
	} catch {
		return 'unparseable';
	}
}

/** キャッシュが45分以内なら再利用し、そうでなければ新しいES256 JWTを署名する。 */
async function getJwt(env: ApnsEnv, cache: ApnsJwtCache): Promise<string> {
	const nowSeconds = Math.floor(Date.now() / 1000);
	if (cache.token && cache.iat !== undefined && nowSeconds - cache.iat < JWT_TTL_SECONDS) {
		return cache.token;
	}
	const key = await importPrivateKey(env.APNS_KEY_P8!);
	const header = { alg: 'ES256', kid: env.APNS_KEY_ID! };
	const claims = { iss: env.APNS_TEAM_ID!, iat: nowSeconds };
	const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
	const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
	const jwt = `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
	cache.token = jwt;
	cache.iat = nowSeconds;
	return jwt;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('pkcs8', pemToDer(pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

function pemToDer(pem: string): ArrayBuffer {
	const b64 = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

function base64UrlJson(obj: unknown): string {
	return base64UrlBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

function base64UrlBytes(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) {
		binary += String.fromCharCode(b);
	}
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
