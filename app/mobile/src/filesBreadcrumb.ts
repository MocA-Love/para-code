// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** ファイルタブのパンくず1つ分。 */
export interface BreadcrumbItem {
	/** 表示名（先頭はスペース名）。 */
	readonly label: string;
	/** 押したときに開くフォルダ（スペースの根からの相対パス。根は ''）。 */
	readonly target: string;
	/** いま開いているフォルダか（押しても何もしないので押せなくする）。 */
	readonly current: boolean;
}

/**
 * 開いているフォルダ `path`（`a/b/c` のような相対パス）から、根から順のパンくずを作る。
 * 途中の階層を押すとそこへ直接戻れるよう、各段の行き先を持たせる。
 */
export function breadcrumbItems(rootName: string | undefined, path: string): BreadcrumbItem[] {
	const segments = path.split('/').filter(segment => segment.length > 0);
	const root: BreadcrumbItem = { label: rootName !== undefined && rootName.length > 0 ? rootName : 'ルート', target: '', current: segments.length === 0 };
	return [root, ...segments.map((segment, index) => ({
		label: segment,
		target: segments.slice(0, index + 1).join('/'),
		current: index === segments.length - 1,
	}))];
}
