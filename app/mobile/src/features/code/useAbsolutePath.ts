// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { FS_ABSOLUTE_PATH_CAPABILITY, FS_ABSOLUTE_PATH_KIND, parseFsAbsolutePathResponse } from '@para/protocol';
import { sendPcRequest, useAppStore } from '../../appState.js';
import { pcHasCapability } from '../../pcCompat.js';
import { isPcUnreachableError } from '../../store.js';
import type { AbsolutePathOption } from './pathMenu.js';
import type { CodeSpace } from './useCodeSpace.js';

/** 問い合わせの待ち時間（PC はパスを直すだけなので短く）。 */
const ABSOLUTE_PATH_TIMEOUT_MS = 15_000;

/**
 * そのスペースの行の「絶対パスをコピー」の状態を返す関数（Q548）。
 *
 * - PC が `fs.absolute-path.v1` を広告していれば、押したときに PC へ 1 回問い合わせる（`sendPcRequest`）。
 *   答えはその場でクリップボードへ写すだけで、state・控え・メニューには残さない（`usageCache.ts` と同じく、
 *   PC の絶対パスを端末に残さない方針）
 * - 補足は、スペースのウィンドウが SSH などの接続先なら「接続先 〈名前〉 のパス」、手元なら「PC 上のパス」
 * - 古い PC は項目を薄くして「PC の Para Code を更新すると使えます」、つながっていなければ「PC につながると使えます」
 */
export function useAbsolutePathOption(codeSpace: Pick<CodeSpace, 'pcId' | 'wsId' | 'live'>): (path: string) => AbsolutePathOption {
	const { pcId, wsId } = codeSpace;
	const { supported, remoteLabel } = useAppStore(useShallow(s => {
		const space = wsId !== undefined ? s.workspace?.workspaces.find(candidate => candidate.id === wsId) : undefined;
		const host = space !== undefined ? s.workspace?.renderers.find(renderer => renderer.windowId === space.windowId)?.host : undefined;
		return {
			supported: pcHasCapability(s.workspace, FS_ABSOLUTE_PATH_CAPABILITY),
			// 接続先なら表示名（無ければ空文字）、手元・不明なら undefined
			remoteLabel: host?.kind === 'remote' ? host.label ?? '' : undefined,
		};
	}));
	const live = codeSpace.live && pcId !== undefined && wsId !== undefined;
	return useCallback((path: string): AbsolutePathOption => {
		if (!supported) {
			return { kind: 'unsupported' };
		}
		if (!live || wsId === undefined) {
			return { kind: 'offline' };
		}
		return {
			kind: 'available',
			hint: remoteLabel === undefined ? 'PC 上のパス' : remoteLabel.length > 0 ? `接続先 ${remoteLabel} のパス` : '接続先のパス',
			load: () => fetchAbsolutePath(pcId, wsId, path),
		};
	}, [supported, live, pcId, wsId, remoteLabel]);
}

/** PC の失敗の `code` を、トーストの補足の文にする（知らない code は PC の文のまま）。 */
export function absolutePathFailureText(error: unknown): string {
	const code = error instanceof Error && 'code' in error ? (error as { code?: unknown }).code : undefined;
	if (code === 'missing') {
		return 'スペースの中にこのファイルが見つかりません';
	}
	if (code === 'remote') {
		return '接続先を確かめられませんでした。つながり直してからやり直してください';
	}
	if (isPcUnreachableError(error)) {
		return 'PC につながっていません';
	}
	return error instanceof Error ? error.message : String(error);
}

async function fetchAbsolutePath(pcId: string | undefined, wsId: string, path: string): Promise<string> {
	let reply: unknown;
	try {
		reply = await sendPcRequest(pcId, 'fs', { t: FS_ABSOLUTE_PATH_KIND, ws: wsId, path }, { timeoutMs: ABSOLUTE_PATH_TIMEOUT_MS });
	} catch (error) {
		throw new Error(absolutePathFailureText(error));
	}
	const parsed = parseFsAbsolutePathResponse(reply);
	if (parsed === undefined) {
		throw new Error('PC から絶対パスを受け取れませんでした');
	}
	return parsed.path;
}
