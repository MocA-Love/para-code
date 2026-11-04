// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 長押しのメニュー（`contextMenu.tsx`）の項目の形。RN を持たない純粋な型なので、項目を組み立てる処理
 * （発言・ファイル・ソース管理・差分）をそのままテストできる。
 */

/** 項目のアイコン。ネイティブのメニューでは SF Symbols、アプリのシートでは lucide の絵に直す（`contextMenu.tsx`）。 */
export type ContextMenuIcon =
	| 'copy' | 'markdown' | 'paragraph' | 'code' | 'select' | 'share'
	| 'name' | 'path' | 'absolutePath' | 'open' | 'diff' | 'stage' | 'unstage'
	| 'hash' | 'subject' | 'browser' | 'note' | 'line';

/** メニュー1項目。`children` があれば入れ子（1段だけ）。 */
export interface ContextMenuAction {
	readonly id: string;
	readonly title: string;
	/** タイトルの下の補足（押せない理由など）。 */
	readonly subtitle?: string;
	readonly icon?: ContextMenuIcon;
	/** この項目の前に区切りを入れる（ネイティブのメニューだけ）。 */
	readonly startsSection?: boolean;
	readonly disabled?: boolean;
	readonly destructive?: boolean;
	readonly children?: readonly ContextMenuAction[];
	/** 選んだときの処理。メニュー（シート）が閉じ切ってから呼ぶ。 */
	readonly onSelect?: () => void;
}

export interface ContextMenuSpec {
	/** メニューの見出し（ファイルの相対パスなど）。 */
	readonly title?: string;
	/** 見出しの下に出す全文（ツールの引数など）。ネイティブのメニューでは見出しに続けて出す。 */
	readonly message?: string;
	readonly actions: readonly ContextMenuAction[];
}

/** 入れ子も含めて、識別子から項目を引く。 */
export function findContextMenuAction(actions: readonly ContextMenuAction[], id: string): ContextMenuAction | undefined {
	for (const action of actions) {
		if (action.id === id) {
			return action;
		}
		const child = action.children?.find(candidate => candidate.id === id);
		if (child !== undefined) {
			return child;
		}
	}
	return undefined;
}

/** 写す・共有するときの道具（画面ではトースト付きのコピーと OS の共有シート、テストでは記録するだけ）。 */
export interface ContextMenuOps {
	/** 写せるビルドか（クリップボードの部品が無ければ、コピーの項目を薄くする）。 */
	readonly canCopy: boolean;
	copy(text: string, toast: string): void;
	/** 押してから取りに行く文字を写す（PC への問い合わせ。取れなければ理由をトーストで出す）。 */
	copyLater(load: () => Promise<string>, toast: string): void;
	share(text: string): void;
}

/** クリップボードの部品が無いビルドで、コピーの項目に添える理由。 */
export const CLIPBOARD_UNAVAILABLE_HINT = 'このビルドではコピーできません';

/** コピーの項目を作る（写せないビルドでは薄くして理由を添える）。 */
export function copyAction(ops: ContextMenuOps, action: Omit<ContextMenuAction, 'onSelect'> & { readonly text: string; readonly toast: string }): ContextMenuAction {
	const { text, toast, ...rest } = action;
	return ops.canCopy
		? { ...rest, onSelect: () => ops.copy(text, toast) }
		: { ...rest, disabled: true, subtitle: CLIPBOARD_UNAVAILABLE_HINT };
}
