// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * PC への画面の寸法の申告（アプリ全体で 1 つ）を、どのターミナルのペインが出しているか。セッションの画面は最近見た
 * ターミナルを隠したまま残すので、ペインが隠れた・外れたときは、自分が出した申告のときだけ取り下げる
 * （後から出たペインの申告を消さない）。
 */
export interface TerminalViewportOwnership<T> {
	/** このペインの申告を出す（持ち主になる）。 */
	claim(owner: object, viewport: T | undefined): void;
	/** このペインの申告を外す。今の持ち主だったら、残っている中で最後に申告したペインの申告に戻す（無ければ取り下げる）。 */
	release(owner: object): void;
}

export function createTerminalViewportOwnership<T>(apply: (viewport: T | undefined) => void): TerminalViewportOwnership<T> {
	// 申告を出したペインを出した順に持つ。最後の 1 つの申告が今 PC へ出ている申告
	const owners: { readonly owner: object; readonly viewport: T | undefined }[] = [];
	const indexOf = (owner: object) => owners.findIndex(entry => entry.owner === owner);
	return {
		claim(owner, viewport) {
			const index = indexOf(owner);
			if (index !== -1) {
				owners.splice(index, 1);
			}
			owners.push({ owner, viewport });
			apply(viewport);
		},
		release(owner) {
			const index = indexOf(owner);
			if (index === -1) {
				return;
			}
			const wasCurrent = index === owners.length - 1;
			owners.splice(index, 1);
			if (wasCurrent) {
				// まだ出ている別のペインがあれば、その申告に戻す
				apply(owners.at(-1)?.viewport);
			}
		},
	};
}
