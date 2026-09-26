// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ログに残すための、エラーの種類とコードだけの短い文字列（`TypeError`・`Error (ENOENT)` など）。
 *
 * エラーの本文にはファイル名やパス（アップロードした画像の名前、PC 側の置き場所）が入りうるので、
 * `console.warn` へエラーをそのまま渡さず、これを渡す。
 */
export function errorKind(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as { readonly code?: unknown }).code;
		return typeof code === 'string' || typeof code === 'number' ? `${error.name} (${String(code)})` : error.name;
	}
	return typeof error;
}
