// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { workspaceUnavailableReason } from '../workspaceAvailability.js';

/**
 * スペースの操作が通らない理由（`src/workspaceAvailability.ts`）。
 *
 * **`s.workspace` 本体は購読しない**（10Hz の再送で画面ごと再描画される。`src/filesLive.ts` と同じ）。
 * セレクタの中で「そのスペースのウィンドウが準備できているか」まで決めて真偽値で受け取る。
 */
export function useWorkspaceUnavailableReason(wsId: string | undefined): string | undefined {
	const input = useAppStore(useShallow(s => {
		const selected = wsId !== undefined ? s.workspace?.workspaces.find(candidate => candidate.id === wsId) : undefined;
		const renderer = selected !== undefined ? s.workspace?.renderers.find(candidate => candidate.windowId === selected.windowId) : undefined;
		return {
			hasWorkspace: wsId !== undefined,
			connection: s.connection,
			pcOnline: s.pcOnline,
			sessionProtocolReady: s.sessionProtocolReady,
			manualOffline: s.manualOffline,
			rendererReady: renderer?.ready === true,
		};
	}));
	return workspaceUnavailableReason(input);
}
