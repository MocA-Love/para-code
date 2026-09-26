// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ConnectionState } from './relayClient.js';

/**
 * スペースに対するファイル・ソース管理の操作が通らない理由（通るときは undefined）。
 *
 * 一覧を薄くして押せなくするだけだと「なぜ押せないのか」が分からないので、理由を文字で出す。
 * 並びは `src/offlineNotice.ts`（島のサブ行）と同じ判断順にそろえる。
 */
export interface WorkspaceAvailabilityInput {
	readonly hasWorkspace: boolean;
	readonly connection: ConnectionState;
	readonly pcOnline: boolean;
	readonly sessionProtocolReady: boolean;
	readonly manualOffline: boolean;
	/** そのスペースを開いている PC 側のウィンドウが操作を受け付けられるか。 */
	readonly rendererReady: boolean;
}

export function workspaceUnavailableReason(input: WorkspaceAvailabilityInput): string | undefined {
	if (!input.hasWorkspace) {
		return 'スペースが選択されていません';
	}
	const connected = input.connection === 'online' && input.pcOnline && input.sessionProtocolReady;
	if (!connected) {
		if (input.manualOffline) {
			return 'PC との接続を切っています';
		}
		if (!input.pcOnline && (input.connection === 'online' || input.connection === 'handshaking')) {
			return 'PC がオフラインです';
		}
		if (input.connection !== 'online') {
			return 'PC との接続が切れています（再接続中）';
		}
		return 'PC との接続を準備しています';
	}
	if (!input.rendererReady) {
		return 'PC 側でこのスペースの画面を再接続しています';
	}
	return undefined;
}
