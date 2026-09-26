// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { StoreState } from '../../store.js';
import type { SpaceRouteStatus, PcRouteStatus } from '../../navigationTargets.js';

/**
 * ソース管理・差分・ファイルの画面が「そのスペースへ要求を出せるか」を決める純関数。
 * 旧画面（`legacy-screens/(tabs)/scm.tsx`・`src/components/filesPanel.tsx`）が画面ごとに
 * 同じ式を書いていたものを1つにまとめた。
 */

/** 判定に使うストアの部分。 */
export type SpaceLinkInput = Pick<StoreState, 'connection' | 'pcOnline' | 'sessionProtocolReady' | 'workspace'>;

/**
 * そのスペースを開いている PC 側のウィンドウ（renderer）の識別子。要求を出した時点の値を覚えておき、
 * 応答が返ったときに変わっていれば捨てる（ウィンドウが作り直された後に古い応答で画面を上書きしない）。
 * 要求を出せないとき（未接続・ウィンドウの準備中）は undefined。
 */
export function rendererTargetOf(state: SpaceLinkInput, wsId: string | undefined): string | undefined {
	if (wsId === undefined || state.connection !== 'online' || !state.pcOnline || !state.sessionProtocolReady || state.workspace === undefined) {
		return undefined;
	}
	const space = state.workspace.workspaces.find(candidate => candidate.id === wsId);
	const renderer = space !== undefined ? state.workspace.renderers.find(candidate => candidate.windowId === space.windowId) : undefined;
	return renderer?.ready === true ? `${state.workspace.desktopEpoch}:${renderer.windowId}:${renderer.rendererGeneration}` : undefined;
}

/**
 * 画面の土台の状態。一度でも `ready` になった画面は、接続が切れてストアのスペースが消えても
 * 中身を外さない（入力途中のコミットメッセージや開いているツリーを守る。切れたことはバナーで出す）。
 *  - `unknownPc`: ペアリング台帳に無い PC
 *  - `loading`: PC の切り替え中・スペースの一覧がまだ届いていない
 *  - `missing`: 一覧は届いたがスペースが無い（PC 側で閉じた）
 *  - `ready`: 表示できる
 */
export type CodeSpaceGate = 'unknownPc' | 'loading' | 'missing' | 'ready';

export function codeSpaceGate(pcStatus: PcRouteStatus, spaceStatus: SpaceRouteStatus, everReady: boolean): CodeSpaceGate {
	if (pcStatus === 'unknown') {
		return 'unknownPc';
	}
	if (everReady) {
		return 'ready';
	}
	if (pcStatus !== 'active') {
		return 'loading';
	}
	return spaceStatus;
}
