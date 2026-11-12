// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { haptic } from '../haptics.js';
import type { LocalFileTarget } from '../localFileTarget.js';
import { paraAlert } from '../paraAlert.js';
import { fileViewerHref } from '../features/code/codeRoutes.js';

/** 開いている途中の印（同じリンクを見分けるキー）。 */
export function localFileTargetKey(target: LocalFileTarget): string {
	return `${target.path}:${target.line ?? ''}:${target.column ?? ''}`;
}

/**
 * 会話の中のファイル（Markdown のファイルのリンクと、ツールのファイルのカード）を押したときに、PC でワークスペースの
 * 中の実在のファイルへ解決してから、ファイルツリーから開いたときと同じビューアの画面へ進める。
 */
export function useLocalFileOpener(): { open: (target: LocalFileTarget) => void; openingKey: string | undefined } {
	// **`s.workspace` 本体を購読してはいけない。** ここが必要としているのは「ファイルリンクを
	// 解決する相手のワークスペースID」という文字列1つだけなのに、本体を購読していたため、
	// PCからの再送（最大10Hz）のたびに**画面に出ている全メッセージがMarkdownを再パース**して
	// いた（`mergeWorkspaceState` が毎回新しいオブジェクトを作るので `useShallow` は効かない）。
	// IDの算出を購読の中でやって文字列に落とせば、中身が変わらない再送では止まる。
	const router = useRouter();
	const { pcId, ws, fsResolveLink } = useAppStore(useShallow(s => {
		const selectedTerminal = s.workspace?.terminals.find(terminal => terminal.terminalKey === s.selectedTerminalKey);
		const terminalWs = selectedTerminal !== undefined ? (selectedTerminal.ws ?? s.workspace?.activeWs) : undefined;
		return {
			pcId: s.activePcId,
			ws: terminalWs ?? s.selectedWs ?? s.workspace?.activeWs ?? s.workspace?.workspaces[0]?.id,
			fsResolveLink: s.fsResolveLink,
		};
	}));
	const [openingKey, setOpeningKey] = useState<string | undefined>();
	const openGeneration = useRef(0);
	useEffect(() => () => { openGeneration.current++; }, []);
	// **参照を安定させる。** 見出し・テーブル・段落はブロック単位で memo 化した子へ渡すため、
	// 毎レンダー新しい関数を渡すと memo が素通りしてインラインの再パースが毎回走る。
	const open = useCallback((target: LocalFileTarget) => {
		if (ws === undefined || pcId === undefined) {
			paraAlert.alert('ファイルを開けません', '対応するワークスペースが見つかりません。');
			return;
		}
		const key = localFileTargetKey(target);
		const generation = ++openGeneration.current;
		haptic('move');
		setOpeningKey(key);
		void fsResolveLink(ws, target.path).then(resolved => {
			if (openGeneration.current === generation) {
				router.push(fileViewerHref(pcId, ws, resolved.path, target.line));
			}
		}).catch(error => {
			if (openGeneration.current === generation) {
				paraAlert.alert('ファイルを開けません', String(error instanceof Error ? error.message : error));
			}
		}).finally(() => {
			if (openGeneration.current === generation) {
				setOpeningKey(current => current === key ? undefined : current);
			}
		});
	}, [pcId, ws, fsResolveLink, router]);
	return { open, openingKey };
}
