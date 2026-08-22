// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useAppStore } from './appState.js';
import { useEffectiveWs } from './components/wsDrawer.js';

/**
 * ファイル操作が通るか（PCと繋がっていて、そのスペースを持つウィンドウのrendererが起きている）。
 *
 * **検索欄（ヘッダーの帯）と一覧で同じ判定を使うために公開している。** 粗い判定
 * （接続だけ見る）を欄側に置くと、rendererの準備待ちのあいだだけ欄が編集できてしまい、
 * 「古い結果に新しい条件が付いている」状態が作れる。
 *
 * **`s.workspace` 本体を購読しない。** 戻り値は boolean なので、セレクタの中で判定まで行い、
 * プリミティブとして受け取る（本体を買うと10Hz再送のたびに検索欄と一覧が不要に再描画されて
 * いた。TextInput を含む検索欄まで巻き込む）。
 */
export function useFilesLive(): boolean {
	const ws = useEffectiveWs();
	return useAppStore(s => {
		if (s.connection !== 'online' || !s.pcOnline || !s.sessionProtocolReady || ws === undefined || s.workspace === undefined) {
			return false;
		}
		const selected = s.workspace.workspaces.find(candidate => candidate.id === ws.id);
		const renderer = selected !== undefined ? s.workspace.renderers.find(candidate => candidate.windowId === selected.windowId) : undefined;
		return renderer?.ready === true;
	});
}
