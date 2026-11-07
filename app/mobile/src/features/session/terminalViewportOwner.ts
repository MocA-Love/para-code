// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * PC への画面の寸法の申告（アプリ全体で 1 つ）を、どのターミナルのペインが出しているか。セッションの画面は最近見た
 * ターミナルを隠したまま残すので、ペインが隠れた・外れたときは、自分が出した申告のときだけ取り下げる
 * （後から出たペインの申告を消さない）。
 */
export interface TerminalViewportOwnership<T> {
	/** このペインの申告を出す（持ち主になる）。 */
	claim(owner: object, viewport: T | undefined): void;
	/** このペインが持ち主なら申告を取り下げる。 */
	release(owner: object): void;
}

export function createTerminalViewportOwnership<T>(apply: (viewport: T | undefined) => void): TerminalViewportOwnership<T> {
	let current: object | undefined;
	return {
		claim(owner, viewport) {
			current = owner;
			apply(viewport);
		},
		release(owner) {
			if (current === owner) {
				current = undefined;
				apply(undefined);
			}
		},
	};
}
