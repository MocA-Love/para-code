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

/** `Authorization: Bearer` ヘッダまたは `?token=` クエリからトークンを取り出す。 */
export function extractToken(request: Request): string | null {
	const auth = request.headers.get('Authorization');
	if (auth?.startsWith('Bearer ')) {
		return auth.slice('Bearer '.length);
	}
	return new URL(request.url).searchParams.get('token');
}
