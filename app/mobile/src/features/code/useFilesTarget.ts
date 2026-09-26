// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { useAppStore } from '../../appState.js';
import { parentPath } from './fileTree.js';
import { resolveUnknownTarget, type FilesTarget } from './fileViewerModel.js';
import { currentRendererTarget, type CodeSpace } from './useCodeSpace.js';

/**
 * ファイルの画面が何を出すかを決める。印（`view`）の無い `path` で開かれたときだけ、親のフォルダを
 * 読んでフォルダかファイルかを確かめる（読めなければファイルとして開いてみる。失敗はビューアが出す）。
 */
export function useFilesTarget(space: CodeSpace, initial: FilesTarget): FilesTarget {
	const fsList = useAppStore(s => s.fsList);
	const [resolved, setResolved] = useState<FilesTarget | undefined>(undefined);
	const unknownPath = initial.kind === 'unknown' ? initial.path : undefined;
	const { wsId, rendererTarget } = space;
	const settled = resolved !== undefined;

	useEffect(() => {
		if (unknownPath === undefined || wsId === undefined || rendererTarget === undefined || settled) {
			return undefined;
		}
		let cancelled = false;
		const current = () => !cancelled && currentRendererTarget(wsId) === rendererTarget;
		fsList(wsId, parentPath(unknownPath))
			.then(result => { if (current()) { setResolved(resolveUnknownTarget(unknownPath, result.entries)); } })
			.catch(() => { if (current()) { setResolved({ kind: 'file', path: unknownPath }); } });
		return () => { cancelled = true; };
	}, [unknownPath, wsId, rendererTarget, settled, fsList]);

	return initial.kind === 'unknown' ? resolved ?? initial : initial;
}
