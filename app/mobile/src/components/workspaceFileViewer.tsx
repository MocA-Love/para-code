// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import type { FsReadResult } from '../store.js';
import { FileViewer, MEDIA_FILE_PATTERN } from './fileViewer.js';
import { classifyMobileFileKind } from './officeCapability.js';

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

/**
 * ワークスペース内のファイル種別に応じた取得処理とフルスクリーン表示をまとめる。
 *
 * Markdown・HTML の中に書かれたパスを押すと、同じビューアの中で開いたファイルを積む（`useViewerPathLinks.tsx`）。
 * 積んでいる間、見出しの「戻る」は 1 つ前のファイルへ戻る（ラベルはそのファイルの名前）。シートを下へ払うと全部閉じる。
 */
export function WorkspaceFileViewer({ ws, path, focusLine, backLabel, onClose }: WorkspaceFileViewerProps) {
	const origin = `${ws}\0${path}\0${focusLine ?? ''}`;
	const [stack, setStack] = useState<{ readonly origin: string; readonly entries: readonly { readonly path: string; readonly line?: number }[] }>({ origin, entries: [] });
	const entries = stack.origin === origin ? stack.entries : [];
	if (stack.origin !== origin) {
		setStack({ origin, entries: [] });
	}
	const top = entries[entries.length - 1];
	const previous = entries.length > 1 ? entries[entries.length - 2]?.path : path;
	const openPath = useCallback((target: string, line: number | undefined) => {
		setStack(current => ({ origin, entries: [...(current.origin === origin ? current.entries : []), { path: target, ...(line !== undefined ? { line } : {}) }] }));
	}, [origin]);
	const back = useCallback(() => {
		setStack(current => ({ origin, entries: current.entries.slice(0, -1) }));
	}, [origin]);
	return (
		<WorkspaceFileViewerContent
			ws={ws}
			path={top?.path ?? path}
			focusLine={top !== undefined ? top.line : focusLine}
			backLabel={top !== undefined ? (previous?.split('/').pop() ?? previous) : backLabel}
			{...(top !== undefined ? { onBack: back } : {})}
			onClose={onClose}
			onOpenPath={openPath}
		/>
	);
}

function WorkspaceFileViewerContent({ ws, path, focusLine, backLabel, onBack, onClose, onOpenPath }: WorkspaceFileViewerProps & { onBack?: () => void; onOpenPath: (path: string, line: number | undefined) => void }) {
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
	const activePcId = useAppStore(s => s.activePcId);
	const pathLinks = useMemo(() => ({ pcId: activePcId, wsId: ws, live, viewerPath: path, open: onOpenPath }), [activePcId, ws, live, path, onOpenPath]);
	const [result, setResult] = useState<FsReadResult | undefined>();
	const [xlsx, setXlsx] = useState<{ html?: string; sheets?: string[]; sheet?: number } | undefined>();
	const [pdf, setPdf] = useState<string | undefined>();
	const [docx, setDocx] = useState<string | undefined>();
	const [media, setMedia] = useState<string | undefined>();
	// 読み込みの失敗。以前は本文の位置に「エラー: …」をコードとして流していた。
	const [error, setErrorMessage] = useState<string | undefined>();
	const loadGeneration = useRef(0);
	const sheetGeneration = useRef(0);
	const contentIdentity = `${ws}\0${path}`;
	const contentIdentityRef = useRef(contentIdentity);

	const setError = useCallback((error: unknown) => {
		setErrorMessage(String(error instanceof Error ? error.message : error));
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
			setErrorMessage(undefined);
		}
		if (!live) {
			return;
		}
		setResult(undefined);
		setXlsx(undefined);
		setPdf(undefined);
		setDocx(undefined);
		setMedia(undefined);
		setErrorMessage(undefined);
		const current = () => loadGeneration.current === generation;
		const requestTarget = rendererTarget;
		const currentRequest = () => current() && currentRendererTarget(ws) === requestTarget;

		const load = async () => {
			try {
				if (classifyMobileFileKind(path) === 'spreadsheet') {
					const value = await fsXlsx(ws, path);
					if (currentRequest()) { setXlsx({ html: value.html, sheets: value.sheets, sheet: value.sheet }); }
				} else if (/\.pdf$/i.test(path)) {
					const value = await fsPdf(ws, path);
					if (currentRequest()) { setPdf(value.data); }
				} else if (classifyMobileFileKind(path) === 'docx') {
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
		setErrorMessage(undefined);
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
			error={error}
			pathLinks={pathLinks}
			{...(onBack !== undefined ? { onBack } : {})}
			onClose={onClose}
		/>
	);
}
