// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from './appState.js';
import { useEffectiveWs } from './components/wsDrawer.js';

/**
 * ファイル操作が通るか（PCと繋がっていて、そのスペースを持つウィンドウのrendererが起きている）。
 *
 * **検索欄（ヘッダーの帯）と一覧で同じ判定を使うために公開している。** 粗い判定
 * （接続だけ見る）を欄側に置くと、rendererの準備待ちのあいだだけ欄が編集できてしまい、
 * 「古い結果に新しい条件が付いている」状態が作れる。
 */
export function useFilesLive(): boolean {
	const { connection, pcOnline, sessionProtocolReady, workspace } = useAppStore(useShallow(s => ({
		connection: s.connection, pcOnline: s.pcOnline, sessionProtocolReady: s.sessionProtocolReady, workspace: s.workspace,
	})));
	const ws = useEffectiveWs();
	const selectedWorkspace = workspace?.workspaces.find(candidate => candidate.id === ws?.id);
	const renderer = selectedWorkspace !== undefined ? workspace?.renderers.find(candidate => candidate.windowId === selectedWorkspace.windowId) : undefined;
	return connection === 'online' && pcOnline && sessionProtocolReady && renderer?.ready === true;
}
