// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../appState.js';
import type { FsReadResult } from '../../store.js';
import { viewerFetchOf, viewerKindOf } from './fileViewerModel.js';
import { errorMessage } from './scmModel.js';
import { currentRendererTarget, type CodeSpace } from './useCodeSpace.js';

export interface FileContent {
	/** `fsRead` の結果（テキスト。ハイライト付き）。 */
	readonly text?: FsReadResult;
	/** 表計算: PC が描いた1シート分の HTML とシートの一覧。 */
	readonly xlsx?: { readonly html?: string; readonly sheets?: readonly string[]; readonly sheet?: number };
	/** PDF・Word・画像・動画・音声のバイナリ（base64）。 */
	readonly binary?: string;
	readonly error?: string;
}

export interface FileContentState {
	readonly content: FileContent | undefined;
	readonly selectSheet: (index: number) => void;
}

/**
 * ビューアの中身を読む（旧 `src/components/workspaceFileViewer.tsx` の取得処理）。種類に応じて
 * `fsXlsx` / `fsPdf` / `fsDocx` / `fsMedia` / `fsRead` を使い分ける。接続し直したら読み直す。
 */
export function useFileContent(space: CodeSpace, path: string): FileContentState {
	const { fsRead, fsXlsx, fsPdf, fsDocx, fsMedia } = useAppStore(useShallow(s => ({ fsRead: s.fsRead, fsXlsx: s.fsXlsx, fsPdf: s.fsPdf, fsDocx: s.fsDocx, fsMedia: s.fsMedia })));
	const [content, setContent] = useState<FileContent | undefined>(undefined);
	const loadGen = useRef(0);
	const sheetGen = useRef(0);
	const { wsId, rendererTarget } = space;
	const fetchKind = viewerFetchOf(viewerKindOf(path));

	useEffect(() => {
		const gen = ++loadGen.current;
		sheetGen.current++;
		if (wsId === undefined || rendererTarget === undefined) {
			return undefined;
		}
		const current = () => loadGen.current === gen && currentRendererTarget(wsId) === rendererTarget;
		const load = async (): Promise<FileContent> => {
			switch (fetchKind) {
				case 'xlsx': {
					const value = await fsXlsx(wsId, path);
					return { xlsx: { html: value.html, sheets: value.sheets, sheet: value.sheet } };
				}
				case 'pdf': return { binary: (await fsPdf(wsId, path)).data };
				case 'docx': return { binary: (await fsDocx(wsId, path)).data };
				case 'media': return { binary: (await fsMedia(wsId, path)).data };
				case 'text': return { text: await fsRead(wsId, path, true) };
			}
		};
		load()
			.then(value => { if (current()) { setContent(value); } })
			.catch((e: unknown) => { if (current()) { setContent({ error: errorMessage(e) }); } });
		return () => { loadGen.current++; };
	}, [wsId, rendererTarget, path, fetchKind, fsRead, fsXlsx, fsPdf, fsDocx, fsMedia]);

	const selectSheet = useCallback((index: number) => {
		if (wsId === undefined || rendererTarget === undefined) {
			return;
		}
		const gen = ++sheetGen.current;
		setContent(previous => (previous?.xlsx !== undefined ? { xlsx: { ...previous.xlsx, sheet: index, html: undefined } } : previous));
		fsXlsx(wsId, path, index)
			.then(value => {
				if (sheetGen.current === gen && currentRendererTarget(wsId) === rendererTarget) {
					setContent({ xlsx: { html: value.html, sheets: value.sheets, sheet: value.sheet } });
				}
			})
			.catch((e: unknown) => {
				if (sheetGen.current === gen && currentRendererTarget(wsId) === rendererTarget) {
					setContent({ error: errorMessage(e) });
				}
			});
	}, [wsId, rendererTarget, path, fsXlsx]);

	return { content, selectSheet };
}
