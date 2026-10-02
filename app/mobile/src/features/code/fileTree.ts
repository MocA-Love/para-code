// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ファイルのツリー（Orca の files/file-tree.ts）。フォルダを開くたびに PC から1階層ずつ読み
 * （`fsList`）、読んだ結果を `DirCache` に貯め、開いているフォルダだけをたどって1列の行にする。
 * React に依存しない純関数で、`fileTree.test.ts` で固定している。
 */

export interface DirEntry {
	readonly name: string;
	readonly dir: boolean;
	readonly size?: number;
	/** .gitignore で無視されている（`fs.ignored.v1` の PC だけが付ける）。 */
	readonly ignored?: boolean;
}

/** 1つのフォルダの読み込み状態。`entries` が無いのは未読み込み。 */
export interface DirState {
	readonly entries?: readonly DirEntry[];
	readonly loading?: boolean;
	readonly error?: string;
}

/** フォルダのパス（根は ''）→ 読み込み状態。 */
export type DirCache = Readonly<Record<string, DirState | undefined>>;

interface TreeEntryRow {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly depth: number;
	readonly size?: number;
	/** 自分か祖先のフォルダが無視されている（PC のエクスプローラーと同じく、無視されたフォルダの中は全部灰）。 */
	readonly ignored?: boolean;
}
interface TreeStatusRow { readonly id: string; readonly path: string; readonly depth: number }

export type TreeRow =
	| (TreeEntryRow & { readonly kind: 'dir' })
	| (TreeEntryRow & { readonly kind: 'file' })
	| (TreeStatusRow & { readonly kind: 'loading' })
	| (TreeStatusRow & { readonly kind: 'error'; readonly message: string });

/**
 * パスはリポジトリ内の任意の文字列なので、`constructor` のような継承されたキーを
 * 読み込み済みのフォルダと取り違えないよう、自分のキーだけを見る。
 */
export function dirState(cache: DirCache, path: string): DirState | undefined {
	return Object.prototype.hasOwnProperty.call(cache, path) ? cache[path] : undefined;
}

export function joinPath(parent: string, name: string): string {
	return parent.length > 0 ? `${parent}/${name}` : name;
}

/** 親のフォルダ（根の直下なら ''）。 */
export function parentPath(path: string): string {
	const at = path.lastIndexOf('/');
	return at < 0 ? '' : path.slice(0, at);
}

export function baseName(path: string): string {
	const at = path.lastIndexOf('/');
	return at < 0 ? path : path.slice(at + 1);
}

/** `a/b/c` → `['a', 'a/b', 'a/b/c']`（そのフォルダまでを開くときに使う）。 */
export function ancestorPaths(path: string): string[] {
	const segments = path.split('/').filter(segment => segment.length > 0);
	return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

/**
 * 開いているフォルダをたどって行にする。フォルダの並びは PC から届いた順のまま
 * （PC 側がエクスプローラーと同じ順で返す）。開いたフォルダが読み込み中・失敗なら、
 * その下に1行だけ状態の行を置く。
 */
export function flattenTree(cache: DirCache, expanded: ReadonlySet<string>): TreeRow[] {
	const rows: TreeRow[] = [];
	visit('', 0, false, cache, expanded, rows);
	return rows;
}

function visit(path: string, depth: number, parentIgnored: boolean, cache: DirCache, expanded: ReadonlySet<string>, rows: TreeRow[]): void {
	for (const entry of dirState(cache, path)?.entries ?? []) {
		const childPath = joinPath(path, entry.name);
		const ignored = parentIgnored || entry.ignored === true;
		const base = { name: entry.name, path: childPath, depth, size: entry.size, ...(ignored ? { ignored } : {}) };
		rows.push(entry.dir ? { ...base, kind: 'dir', id: `dir:${childPath}` } : { ...base, kind: 'file', id: `file:${childPath}` });
		if (!entry.dir || !expanded.has(childPath)) {
			continue;
		}
		const child = dirState(cache, childPath);
		if (child?.error !== undefined) {
			rows.push({ kind: 'error', id: `error:${childPath}`, path: childPath, depth: depth + 1, message: child.error });
		} else if (child?.entries === undefined || (child.loading === true && child.entries.length === 0)) {
			rows.push({ kind: 'loading', id: `loading:${childPath}`, path: childPath, depth: depth + 1 });
		} else {
			visit(childPath, depth + 1, ignored, cache, expanded, rows);
		}
	}
}

/** フォルダを開くときに読みに行くか（まだ読んでいない・前回失敗した。読み込み中なら行かない）。 */
export function needsLoad(cache: DirCache, path: string): boolean {
	const state = dirState(cache, path);
	return state === undefined || (state.loading !== true && (state.entries === undefined || state.error !== undefined));
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
