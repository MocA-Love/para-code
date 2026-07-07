// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** トークンのハッシュ化と検証（リレーは生トークンを保存しない）。 */

export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
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
	const raw = crypto.getRandomValues(new Uint8Array(bytes));
	let base64 = btoa(String.fromCharCode(...raw));
	return base64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
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
	return new URL(request.url).searchParams.get('token');
}
