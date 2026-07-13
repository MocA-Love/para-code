// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** 画面キーボードのEnterは常に改行とし、送信は明示ボタンだけに限定する。 */
export function glassComposerTextInputBehavior(): { multiline: true; blurOnSubmit: false } {
	return { multiline: true, blurOnSubmit: false };
}
