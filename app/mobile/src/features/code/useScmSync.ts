// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
	PARADIS_MOBILE_SCM_STAGE_FILE_CAPABILITY,
	PARADIS_MOBILE_SCM_SYNC_CAPABILITY,
	type ParadisMobileSyncOperation,
} from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileScmSync.js';
import { sendPcRequest } from '../../appState.js';
import { haptic } from '../../haptics.js';
import { usePcCapability } from '../../hooks/usePcCapability.js';
import { errorMessage, type ScmEntry } from './scmModel.js';
import { agentHandoffResult, type AgentHandoffResult } from './scmSync.js';
import { currentRendererTarget, type CodeSpace } from './useCodeSpace.js';

/**
 * ソース管理の同期・ファイルごとのステージ・エージェントへの依頼（Orca W2-15）。どれも PC の登録表の種類
 * （`push` / `fetch` / `pull` / `stage` / `unstage` / `commitFix`）を `sendPcRequest` で送る。PC が広告して
 * いなければ `enabled` が false になり、画面はボタンを出さない。
 *
 * 失敗はこの画面の中（一覧の上・コミットバーの上）に出す。シートの中では使わない。
 */

/** push・pull は認証とネットワークを待つので長めに待つ（PC 側は push だけで 120 秒、前後の読み取りを足した合計より長く）。 */
const SYNC_TIMEOUT_MS = 200_000;
/** エージェントの起動を待つ（PC 側は 45 秒で打ち切る）。CI の直しは PR とログの取得（最大 3 件）が先に入る。 */
const HANDOFF_TIMEOUT_MS = 200_000;

export interface ScmSyncController {
	readonly enabled: boolean;
	readonly syncing: ParadisMobileSyncOperation | undefined;
	readonly error: string | undefined;
	readonly clearError: () => void;
	/** 同期する。成功したら終わったことの一言（「プッシュしました」など）、失敗なら undefined（呼び出し側が一覧を読み直す）。 */
	readonly run: (operation: ParadisMobileSyncOperation) => Promise<string | undefined>;
}

const DONE: Record<ParadisMobileSyncOperation, string> = { push: 'プッシュしました', pull: '取り込みました', fetch: 'リモートの状態を読み直しました' };

export function useScmSync(space: CodeSpace): ScmSyncController {
	const enabled = usePcCapability(PARADIS_MOBILE_SCM_SYNC_CAPABILITY);
	const [syncing, setSyncing] = useState<ParadisMobileSyncOperation | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const genRef = useRef(0);
	const { pcId, wsId, rendererTarget } = space;

	const run = useCallback(async (operation: ParadisMobileSyncOperation) => {
		if (!enabled || wsId === undefined || rendererTarget === undefined || syncing !== undefined) {
			return undefined;
		}
		const gen = ++genRef.current;
		const current = () => genRef.current === gen && currentRendererTarget(wsId) === rendererTarget;
		setSyncing(operation);
		setError(undefined);
		try {
			const reply = await sendPcRequest<{ readonly published?: unknown }>(pcId, 'scm', { t: operation, ws: wsId }, { timeoutMs: SYNC_TIMEOUT_MS });
			if (!current()) {
				return undefined;
			}
			// 押したときの commit とは別に、PC 側の結果を返す
			haptic('success');
			return reply.published === true ? 'ブランチを公開しました' : DONE[operation];
		} catch (e) {
			if (current()) {
				haptic('error');
				setError(errorMessage(e));
			}
			return undefined;
		} finally {
			if (current()) {
				setSyncing(undefined);
			}
		}
	}, [enabled, pcId, wsId, rendererTarget, syncing]);

	useEffect(() => {
		genRef.current++;
		setSyncing(undefined);
	}, [rendererTarget]);

	const clearError = useCallback(() => setError(undefined), []);

	return { enabled, syncing, error, clearError, run };
}

export interface StageFileController {
	readonly enabled: boolean;
	/** PC の応答を待っているファイル。 */
	readonly pending: ReadonlySet<string>;
	/** ステージ済みならステージを外し、そうでなければステージする。できたら true。失敗は `onError` で知らせる。 */
	readonly toggle: (entry: ScmEntry) => Promise<boolean>;
}

export function useStageFile(space: CodeSpace, onError: (message: string) => void): StageFileController {
	const enabled = usePcCapability(PARADIS_MOBILE_SCM_STAGE_FILE_CAPABILITY);
	const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
	const { pcId, wsId } = space;

	const toggle = useCallback(async (entry: ScmEntry) => {
		if (!enabled || wsId === undefined) {
			return false;
		}
		setPending(previous => new Set([...previous, entry.path]));
		try {
			const reply = await sendPcRequest<{ readonly done?: unknown }>(pcId, 'scm', { t: entry.staged ? 'unstage' : 'stage', ws: wsId, paths: [entry.path] });
			const done = Array.isArray(reply.done) && reply.done.includes(entry.path);
			if (!done) {
				onError('一覧が古くなっていたため、変えませんでした。読み直してください。');
			}
			return done;
		} catch (e) {
			onError(`${entry.staged ? 'ステージを外せませんでした' : 'ステージできませんでした'}: ${errorMessage(e)}`);
			return false;
		} finally {
			setPending(previous => {
				const next = new Set(previous);
				next.delete(entry.path);
				return next;
			});
		}
	}, [enabled, pcId, wsId, onError]);

	return { enabled, pending, toggle };
}

export interface AgentHandoffController {
	readonly sending: boolean;
	readonly result: AgentHandoffResult | undefined;
	/**
	 * 頼む。`auto` はそのスペースで入力を待っているエージェントへ（いなければ既定のエージェントを起動）、
	 * `new` は既定のエージェントを新しく起動する。
	 */
	readonly send: (body: { readonly t: string; readonly [key: string]: unknown }, target: 'auto' | 'new') => Promise<void>;
	readonly reset: () => void;
}

/** エージェントに直してもらう（コミットの失敗 `commitFix`・CI の失敗 `prFixChecks` で共通）。 */
export function useAgentHandoff(space: CodeSpace): AgentHandoffController {
	const [sending, setSending] = useState(false);
	const [result, setResult] = useState<AgentHandoffResult | undefined>(undefined);
	const { pcId, wsId } = space;

	const send = useCallback(async (body: { readonly t: string; readonly [key: string]: unknown }, target: 'auto' | 'new') => {
		if (wsId === undefined || sending) {
			return;
		}
		setSending(true);
		setResult(undefined);
		try {
			const reply = await sendPcRequest<Parameters<typeof agentHandoffResult>[0]>(pcId, 'scm', { ...body, ws: wsId, target }, { timeoutMs: HANDOFF_TIMEOUT_MS });
			setResult(agentHandoffResult(reply));
		} catch (e) {
			setResult({ delivered: false, text: errorMessage(e), busy: false });
		} finally {
			setSending(false);
		}
	}, [pcId, wsId, sending]);

	const reset = useCallback(() => setResult(undefined), []);

	return { sending, result, send, reset };
}
