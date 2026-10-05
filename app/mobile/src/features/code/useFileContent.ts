// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../appState.js';
import type { FsReadResult } from '../../store.js';
import { pcReplyErrorCode } from '../../store.js';
import { viewerFetchOf, viewerKindOf, wantsHighlight, type ViewerMode } from './fileViewerModel.js';
import { FileViewerLoadTrace } from './fileViewerTiming.js';
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
	/** まだ開けない形式（表示の分岐が無い拡張子か、PC がテキストではないと返した）。 */
	readonly unsupported?: true;
	/** 開いてから表示し終えるまでの計測（Sentry の `para.mobileFileViewer.display`）。画面が区間を書き足す。 */
	readonly trace?: FileViewerLoadTrace;
}

export interface FileContentState {
	readonly content: FileContent | undefined;
	readonly selectSheet: (index: number) => void;
}

/**
 * ビューアの中身を読む（旧 `src/components/workspaceFileViewer.tsx` の取得処理）。種類に応じて
 * `fsXlsx` / `fsPdf` / `fsDocx` / `fsMedia` / `fsRead` を使い分ける。接続し直したら読み直す。
 *
 * テキストは、コードの表示でだけ PC にハイライトを頼む（設計書 4 章の着手順 9）。Markdown・HTML のプレビューでは
 * 頼まず、ソースへ切り替えたときに初めてハイライト付きで読み直す。一度ハイライト付きで読んだら、プレビューへ
 * 戻しても読み直さない（ハイライト付きの応答は本文も含む）。まだ開けない形式は PC へ読みに行かない。
 */
export function useFileContent(space: CodeSpace, path: string, mode: ViewerMode): FileContentState {
	const { fsRead, fsXlsx, fsPdf, fsDocx, fsMedia } = useAppStore(useShallow(s => ({ fsRead: s.fsRead, fsXlsx: s.fsXlsx, fsPdf: s.fsPdf, fsDocx: s.fsDocx, fsMedia: s.fsMedia })));
	const [content, setContent] = useState<FileContent | undefined>(undefined);
	const loadGen = useRef(0);
	const sheetGen = useRef(0);
	const { wsId, rendererTarget } = space;
	const kind = viewerKindOf(path);
	const fetchKind = viewerFetchOf(kind);
	// ハイライトは一度頼んだら（このファイルを開いている間は）頼み続ける。プレビューへ戻すたびに読み直さないため
	const [highlightFor, setHighlightFor] = useState<string | undefined>(wantsHighlight(kind, mode) ? path : undefined);
	if (wantsHighlight(kind, mode) && highlightFor !== path) {
		setHighlightFor(path);
	}
	const highlight = highlightFor === path;

	useEffect(() => {
		const gen = ++loadGen.current;
		sheetGen.current++;
		if (wsId === undefined || rendererTarget === undefined) {
			return undefined;
		}
		if (fetchKind === 'none') {
			setContent({ unsupported: true });
			return undefined;
		}
		const current = () => loadGen.current === gen && currentRendererTarget(wsId) === rendererTarget;
		const trace = new FileViewerLoadTrace(fetchKind, path);
		// 応答そのもの（response）も返すのは、計測で PC 側の記録と突き合わせる要求の id を読むため。
		const load = async (): Promise<{ readonly value: FileContent; readonly response: object }> => {
			switch (fetchKind) {
				case 'xlsx': {
					const response = await fsXlsx(wsId, path);
					return { response, value: { xlsx: { html: response.html, sheets: response.sheets, sheet: response.sheet } } };
				}
				case 'pdf': {
					const response = await fsPdf(wsId, path);
					return { response, value: { binary: response.data } };
				}
				case 'docx': {
					const response = await fsDocx(wsId, path);
					return { response, value: { binary: response.data } };
				}
				case 'media': {
					const response = await fsMedia(wsId, path);
					return { response, value: { binary: response.data } };
				}
				case 'text': {
					const response = await fsRead(wsId, path, highlight);
					return { response, value: { text: response } };
				}
			}
		};
		load()
			.then(({ value, response }) => {
				if (current()) {
					trace.fetched(response);
					setContent({ ...value, trace });
				}
			})
			.catch((e: unknown) => {
				if (current()) {
					trace.failed();
					// PC が中身をテキストではないと判断した（先頭に NUL がある）
					setContent(pcReplyErrorCode(e) === 'not-text' ? { unsupported: true } : { error: errorMessage(e) });
				}
			});
		return () => {
			loadGen.current++;
			// 表示し終える前に閉じた・読み直した。表示し終えていれば何もしない。
			trace.cancel();
		};
	}, [wsId, rendererTarget, path, fetchKind, highlight, fsRead, fsXlsx, fsPdf, fsDocx, fsMedia]);

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
