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
const PUSH_EXPIRATION_SECONDS = 4 * 3600;

export type ApnsSendResult = 'sent' | 'unregistered' | 'skipped' | 'error';

export interface ApnsNotification {
	/** APNsデバイストークン（16進）。 */
	readonly token: string;
	readonly env: 'prod' | 'dev';
	/** E2E暗号文（base64url文字列のまま載せる）。 */
	readonly payload: string;
}

/**
 * 対象デバイスへAPNs通知を1件送信する。シークレット未設定なら 'skipped' を返す。
 * 410 Unregistered のときは 'unregistered' を返す（呼び出し側でトークンを削除する）。
 */
export async function sendApnsNotification(env: ApnsEnv, notification: ApnsNotification, cache: ApnsJwtCache): Promise<ApnsSendResult> {
	if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) {
		console.warn('[apns] secrets not configured; skipping push-notify');
		return 'skipped';
	}

	let jwt: string;
	try {
		jwt = await getJwt(env, cache);
	} catch (err) {
		console.warn('[apns] failed to build auth JWT:', err);
		return 'error';
	}

	const host = notification.env === 'dev' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
	const nowSeconds = Math.floor(Date.now() / 1000);
	const body = JSON.stringify({
		aps: {
			alert: { title: 'Para Code', body: '新しい通知があります' },
			sound: 'default',
			'mutable-content': 1,
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
				'apns-expiration': String(nowSeconds + PUSH_EXPIRATION_SECONDS),
			},
			body,
		});
	} catch (err) {
		console.warn('[apns] request failed:', err);
		return 'error';
	}

	if (res.status === 410) {
		return 'unregistered';
	}
	if (!res.ok) {
		console.warn(`[apns] push rejected: ${res.status}`);
		return 'error';
	}
	return 'sent';
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
