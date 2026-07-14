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

function currentRendererTarget(ws: string): string | undefined {
	const state = useAppStore.getState();
	if (state.connection !== 'online' || !state.pcOnline || !state.sessionProtocolReady) {
		return undefined;
	}
	const selectedWorkspace = state.workspace?.workspaces.find(candidate => candidate.id === ws);
	const renderer = selectedWorkspace !== undefined ? state.workspace?.renderers.find(candidate => candidate.windowId === selectedWorkspace.windowId) : undefined;
	return renderer?.ready === true && state.workspace !== undefined
		? `${state.workspace.desktopEpoch}:${renderer.windowId}:${renderer.rendererGeneration}`
		: undefined;
}

/** ワークスペース内のファイル種別に応じた取得処理とフルスクリーン表示をまとめる。 */
export function WorkspaceFileViewer({ ws, path, focusLine, backLabel, onClose }: WorkspaceFileViewerProps) {
	const { fsRead, fsXlsx, fsPdf, fsDocx, fsMedia, connection, pcOnline, sessionProtocolReady, workspace } = useAppStore(useShallow(s => ({
		fsRead: s.fsRead,
		fsXlsx: s.fsXlsx,
		fsPdf: s.fsPdf,
		fsDocx: s.fsDocx,
		fsMedia: s.fsMedia,
		connection: s.connection,
		pcOnline: s.pcOnline,
		sessionProtocolReady: s.sessionProtocolReady,
		workspace: s.workspace,
	})));
	const selectedWorkspace = workspace?.workspaces.find(candidate => candidate.id === ws);
	const selectedRenderer = selectedWorkspace !== undefined ? workspace?.renderers.find(candidate => candidate.windowId === selectedWorkspace.windowId) : undefined;
	const rendererTarget = selectedRenderer?.ready === true && workspace !== undefined
		? `${workspace.desktopEpoch}:${selectedRenderer.windowId}:${selectedRenderer.rendererGeneration}`
		: undefined;
	const live = connection === 'online' && pcOnline && sessionProtocolReady && rendererTarget !== undefined;
	const [result, setResult] = useState<FsReadResult | undefined>();
	const [xlsx, setXlsx] = useState<{ html?: string; sheets?: string[]; sheet?: number } | undefined>();
	const [pdf, setPdf] = useState<string | undefined>();
	const [docx, setDocx] = useState<string | undefined>();
	const [media, setMedia] = useState<string | undefined>();
	const loadGeneration = useRef(0);
	const sheetGeneration = useRef(0);
	const contentIdentity = `${ws}\0${path}`;
	const contentIdentityRef = useRef(contentIdentity);

	const setError = useCallback((error: unknown) => {
		setResult({ content: `エラー: ${String(error instanceof Error ? error.message : error)}`, truncated: false, size: 0 });
	}, []);

	useEffect(() => {
		const generation = ++loadGeneration.current;
		sheetGeneration.current++;
		if (contentIdentityRef.current !== contentIdentity) {
			contentIdentityRef.current = contentIdentity;
			setResult(undefined);
			setXlsx(undefined);
			setPdf(undefined);
			setDocx(undefined);
			setMedia(undefined);
		}
		if (!live) {
			return;
		}
		setResult(undefined);
		setXlsx(undefined);
		setPdf(undefined);
		setDocx(undefined);
		setMedia(undefined);
		const current = () => loadGeneration.current === generation;
		const requestTarget = rendererTarget;
		const currentRequest = () => current() && currentRendererTarget(ws) === requestTarget;

		const load = async () => {
			try {
				if (/\.(?:xlsx|xlsm)$/i.test(path)) {
					const value = await fsXlsx(ws, path);
					if (currentRequest()) { setXlsx({ html: value.html, sheets: value.sheets, sheet: value.sheet }); }
				} else if (/\.pdf$/i.test(path)) {
					const value = await fsPdf(ws, path);
					if (currentRequest()) { setPdf(value.data); }
				} else if (/\.docx$/i.test(path)) {
					const value = await fsDocx(ws, path);
					if (currentRequest()) { setDocx(value.data); }
				} else if (MEDIA_FILE_PATTERN.test(path)) {
					const value = await fsMedia(ws, path);
					if (currentRequest()) { setMedia(value.data); }
				} else {
					const value = await fsRead(ws, path, true);
					if (currentRequest()) { setResult(value); }
				}
			} catch (error) {
				if (currentRequest()) { setError(error); }
			}
		};
		void load();
		return () => { loadGeneration.current++; sheetGeneration.current++; };
	}, [ws, path, contentIdentity, live, rendererTarget, fsRead, fsXlsx, fsPdf, fsDocx, fsMedia, setError]);

	const selectSheet = useCallback(async (index: number) => {
		if (!live) {
			return;
		}
		const generation = ++sheetGeneration.current;
		const requestTarget = rendererTarget;
		setXlsx(previous => previous ? { ...previous, sheet: index, html: undefined } : previous);
		try {
			const value = await fsXlsx(ws, path, index);
			if (sheetGeneration.current === generation && currentRendererTarget(ws) === requestTarget) {
				setXlsx({ html: value.html, sheets: value.sheets, sheet: value.sheet });
			}
		} catch (error) {
			if (sheetGeneration.current === generation && currentRendererTarget(ws) === requestTarget) { setError(error); }
		}
	}, [ws, path, live, rendererTarget, fsXlsx, setError]);

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
