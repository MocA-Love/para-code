// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 画面に出たファイルのリンク（`src/app.ts:42` / `src/app.ts#L42C3` / `file:///…`）を、パスと行・桁に分ける。
 * チャットの Markdown（`markdownText.tsx`）とターミナルのタップ（`terminalLinks.ts`）が同じ規則で読む。
 */

/** ワークスペースの中のファイルと、開いたときに見せる行・桁。 */
export interface LocalFileTarget {
	path: string;
	line?: number;
	column?: number;
}

/** 行指定（`:4:2` / `#L4C2` / `#L4-L8`）をパス本体から分離する。 */
export function parseLocalFileTarget(destination: string): LocalFileTarget | undefined {
	if (/^https?:\/\//i.test(destination)) {
		return undefined;
	}
	let path = destination.trim();
	let line: number | undefined;
	let column: number | undefined;
	const fragmentIndex = path.lastIndexOf('#');
	if (fragmentIndex >= 0) {
		const fragment = path.slice(fragmentIndex);
		const location = /^#L(?<line>\d+)(?:C(?<column>\d+))?(?:-L\d+(?:C\d+)?)?$/i.exec(fragment);
		if (location?.groups?.line === undefined) {
			return undefined;
		}
		line = Number(location.groups.line);
		column = location.groups.column !== undefined ? Number(location.groups.column) : undefined;
		path = path.slice(0, fragmentIndex);
	}
	if (line === undefined) {
		const lineColumnSuffix = /^(?<path>.+):(?<line>\d+):(?<column>\d+)$/.exec(path);
		const lineSuffix = lineColumnSuffix ?? /^(?<path>.+):(?<line>\d+)$/.exec(path);
		if (lineSuffix?.groups?.path !== undefined && lineSuffix.groups.line !== undefined) {
			path = lineSuffix.groups.path;
			line = Number(lineSuffix.groups.line);
			column = lineSuffix.groups.column !== undefined ? Number(lineSuffix.groups.column) : undefined;
		}
	}
	if (/^file:\/\//i.test(path)) {
		path = path.slice('file://'.length);
		if (/^localhost\//i.test(path)) { path = path.slice('localhost'.length); }
	} else if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) {
		return undefined; // javascript: / mailto: 等は実行もファイル解決もしない
	}
	try {
		path = decodeURIComponent(path);
	} catch {
		return undefined;
	}
	if (path.length === 0 || path.startsWith('#') || line === 0 || column === 0) {
		return undefined;
	}
	if ((line !== undefined && (!Number.isSafeInteger(line) || line > 2_147_483_647))
		|| (column !== undefined && (!Number.isSafeInteger(column) || column > 2_147_483_647))) {
		return undefined;
	}
	return {
		path,
		...(line !== undefined ? { line } : {}),
		...(column !== undefined ? { column } : {}),
	};
}
