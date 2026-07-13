// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import type { FsReadResult } from '../store.js';
import { FileViewer, MEDIA_FILE_PATTERN } from './fileViewer.js';

interface WorkspaceFileViewerProps {
	ws: string;
	path: string;
	focusLine?: number;
	backLabel?: string;
	onClose: () => void;
}

/** ワークスペース内のファイル種別に応じた取得処理とフルスクリーン表示をまとめる。 */
export function WorkspaceFileViewer({ ws, path, focusLine, backLabel, onClose }: WorkspaceFileViewerProps) {
	const { fsRead, fsXlsx, fsPdf, fsDocx, fsMedia } = useAppStore(useShallow(s => ({
		fsRead: s.fsRead,
		fsXlsx: s.fsXlsx,
		fsPdf: s.fsPdf,
		fsDocx: s.fsDocx,
		fsMedia: s.fsMedia,
	})));
	const [result, setResult] = useState<FsReadResult | undefined>();
	const [xlsx, setXlsx] = useState<{ html?: string; sheets?: string[]; sheet?: number } | undefined>();
	const [pdf, setPdf] = useState<string | undefined>();
	const [docx, setDocx] = useState<string | undefined>();
	const [media, setMedia] = useState<string | undefined>();
	const loadGeneration = useRef(0);
	const sheetGeneration = useRef(0);

	const setError = useCallback((error: unknown) => {
		setResult({ content: `エラー: ${String(error instanceof Error ? error.message : error)}`, truncated: false, size: 0 });
	}, []);

	useEffect(() => {
		const generation = ++loadGeneration.current;
		setResult(undefined);
		setXlsx(undefined);
		setPdf(undefined);
		setDocx(undefined);
		setMedia(undefined);
		const current = () => loadGeneration.current === generation;

		const load = async () => {
			try {
				if (/\.(?:xlsx|xlsm)$/i.test(path)) {
					const value = await fsXlsx(ws, path);
					if (current()) { setXlsx({ html: value.html, sheets: value.sheets, sheet: value.sheet }); }
				} else if (/\.pdf$/i.test(path)) {
					const value = await fsPdf(ws, path);
					if (current()) { setPdf(value.data); }
				} else if (/\.docx$/i.test(path)) {
					const value = await fsDocx(ws, path);
					if (current()) { setDocx(value.data); }
				} else if (MEDIA_FILE_PATTERN.test(path)) {
					const value = await fsMedia(ws, path);
					if (current()) { setMedia(value.data); }
				} else {
					const value = await fsRead(ws, path, true);
					if (current()) { setResult(value); }
				}
			} catch (error) {
				if (current()) { setError(error); }
			}
		};
		void load();
		return () => { loadGeneration.current++; sheetGeneration.current++; };
	}, [ws, path, fsRead, fsXlsx, fsPdf, fsDocx, fsMedia, setError]);

	const selectSheet = useCallback(async (index: number) => {
		const generation = ++sheetGeneration.current;
		setXlsx(previous => previous ? { ...previous, sheet: index, html: undefined } : previous);
		try {
			const value = await fsXlsx(ws, path, index);
			if (sheetGeneration.current === generation) {
				setXlsx({ html: value.html, sheets: value.sheets, sheet: value.sheet });
			}
		} catch (error) {
			if (sheetGeneration.current === generation) { setError(error); }
		}
	}, [ws, path, fsXlsx, setError]);

	return (
		<FileViewer
			path={path}
			result={result}
			spreadsheetHtml={xlsx?.html}
			sheets={xlsx?.sheets}
			sheetIndex={xlsx?.sheet}
			onSelectSheet={selectSheet}
			pdfData={pdf}
			docxData={docx}
			mediaData={media}
			focusLine={focusLine}
			backLabel={backLabel}
			onClose={onClose}
		/>
	);
}
