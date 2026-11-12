// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** トークンのハッシュ化と検証（リレーは生トークンを保存しない）。 */

import { fromBase64Url, toBase64Url } from '@para/protocol';

function toHex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hashToken(token: string): Promise<string> {
	return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}

/**
 * ペアリングの pairing-msg（base64url の JSON `{ pub, name }`）が名乗るモバイル長期公開鍵の指紋
 * （32 バイトの鍵の SHA-256、16進64桁小文字）。PC が承認に添える keyFingerprint と同じ作り方。
 * 形が違えば undefined。
 */
export async function pairingKeyFingerprint(data: string): Promise<string | undefined> {
	try {
		const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(data))) as { pub?: unknown };
		if (typeof payload.pub !== 'string') {
			return undefined;
		}
		const pub = fromBase64Url(payload.pub);
		if (pub.length !== 32) {
			return undefined;
		}
		return toHex(await crypto.subtle.digest('SHA-256', pub as BufferSource));
	} catch {
		return undefined;
	}
}

/** タイミング攻撃を避ける固定時間比較。 */
export function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

export function randomTokenB64u(bytes = 32): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

// WebSocketアップグレード時にトークンを載せるサブプロトコル接頭辞（`para-auth.<token>`）。
// トークンはbase64url（`A-Za-z0-9-_`）なのでRFC6455のsubprotocol token文字集合に収まり、
// そのまま Sec-WebSocket-Protocol に載せられる。URLクエリと違いWorkers LogsのリクエストURLに
// 残らないため、長期トークンの平文ログ蓄積を防げる（finding #7）。
export const SUBPROTOCOL_AUTH_PREFIX = 'para-auth.';

/** クライアントが提示した `para-auth.<token>` サブプロトコルの原文を返す（echo用）。 */
export function subprotocolAuthHeader(request: Request): string | null {
	const header = request.headers.get('Sec-WebSocket-Protocol');
	if (!header) {
		return null;
	}
	for (const proto of header.split(',')) {
		const trimmed = proto.trim();
		if (trimmed.startsWith(SUBPROTOCOL_AUTH_PREFIX) && trimmed.length > SUBPROTOCOL_AUTH_PREFIX.length) {
			return trimmed;
		}
	}
	return null;
}

/**
 * リクエストからトークンを取り出す。優先順位:
 *  1. `Authorization: Bearer <token>` ヘッダ（HTTP API）
 *  2. `Sec-WebSocket-Protocol: para-auth.<token>` サブプロトコル（WebSocket、推奨）
 *  3. `?token=` クエリ（DEPRECATED: 旧クライアント互換。トークンがWorkers Logsの
 *     リクエストURLに平文で残るため、新クライアントは 2 を使う。finding #7）
 */
export function extractToken(request: Request): string | null {
	const auth = request.headers.get('Authorization');
	if (auth?.startsWith('Bearer ')) {
		return auth.slice('Bearer '.length);
	}
	const proto = subprotocolAuthHeader(request);
	if (proto !== null) {
		return proto.slice(SUBPROTOCOL_AUTH_PREFIX.length);
	}
	// DEPRECATED（旧クライアント互換）: クエリのトークンはWorkers Logsに残る。
	const url = new URL(request.url);
	const token = url.searchParams.get('token');
	if (token !== null) {
		// 外す時期を決めるために、使われた回数を Workers Logs でこの印から数える（Q620）。
		// トークンと URL は書かない（警告そのものを平文の写しにしない）。DO には Worker が `https://do/?role=…` に
		// 写した要求が届くので、経路ではなく接続の種類だけを載せる。
		console.warn(DEPRECATED_QUERY_TOKEN_LOG, { role: deprecatedQueryTokenRole(url.searchParams.get('role')) });
	}
	return token;
}

/** `?token=` のクエリで認証した要求に出す警告の印。Workers Logs ではこの文字列で数える。 */
export const DEPRECATED_QUERY_TOKEN_LOG = '[relay] deprecated query token';

/** 警告に載せる `role`。知っている値だけを写し、それ以外は書かない。 */
function deprecatedQueryTokenRole(role: string | null): string | undefined {
	return role === 'pc' || role === 'mobile' || role === 'pair' ? role : undefined;
}
