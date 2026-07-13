// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

let latestEntrySequence = 0;

/** ホーム／通知から詳細を開く操作を、同一ミリ秒でも区別できる一度限りのIDにする。 */
export function createAgentLatestEntryToken(now: number = Date.now()): string {
	latestEntrySequence = (latestEntrySequence + 1) % Number.MAX_SAFE_INTEGER;
	return `${now.toString(36)}-${latestEntrySequence.toString(36)}`;
}

/** 同じ画面へ戻っただけなら再スクロールせず、新しい遷移要求だけ処理する。 */
export function shouldHandleLatestEntry(lastHandled: string | undefined, requested: string | undefined): boolean {
	return requested !== undefined && requested !== lastHandled;
}
