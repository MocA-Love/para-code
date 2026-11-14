// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { isNoResponseError } from './features/usage/usageAggregate.js';

/** PC から返事が無かった（時間切れ）ときの理由の文。 */
export const PC_NO_RESPONSE_REASON = 'PC から返事がありませんでした。PC の Para Code が開いているか確かめてください';
/** PC で開いているスペースが見つからなかったときの理由の文。 */
export const PC_WORKSPACE_NOT_FOUND_REASON = 'PC で開いているスペースが見つかりませんでした。PC で Para Code のウィンドウを開いてください';

/**
 * PC への要求の失敗を、画面の「理由」の欄に入れる日本語の文にする（末尾に句点は付けない）。
 * 英語の内部の文（時間切れ・スペースが無い）は言い換え、それ以外の文（日本語の「つながっていない」や PC が返した文）はそのまま返す。
 * Error でないものは `fallback` を返す。
 */
export function pcRequestErrorText(error: unknown, fallback: string): string {
	if (isNoResponseError(error)) {
		return PC_NO_RESPONSE_REASON;
	}
	if (!(error instanceof Error)) {
		return fallback;
	}
	if (error.message === 'workspace not found') {
		return PC_WORKSPACE_NOT_FOUND_REASON;
	}
	return error.message;
}
