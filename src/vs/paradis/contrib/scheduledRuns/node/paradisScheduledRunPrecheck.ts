/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 定期実行の事前確認のコマンドを走らせる（shared process）。
//
// Orca（stablyai/orca、MIT）の `src/main/automations/precheck-runner.ts` と同じ考え方で、シェルでコマンドを
// 走らせ、終了コードと出力の末尾を返す（コードは移していない）。
// - 環境はログインシェルから解いたもの（Dock から起動した Para Code でも `gh` などが PATH にあるように）
// - POSIX では自分のプロセスグループで起こし、時間切れ・取りやめではグループごと止める（孫を残さない）
// - 出力は末尾だけを持ち、秘密らしい値を伏せる。出力はエージェントへの指示には足さない

import * as cp from 'child_process';
import { paradisRedactTextSecrets } from '../../../common/paradisSecretRedaction.js';
import { paradisKillChildProcessTree } from '../../../node/paradisKillChildProcess.js';
import { IParadisScheduledRunPrecheckResult, PARADIS_SCHEDULED_RUN_PRECHECK_OUTPUT_LENGTH } from '../common/paradisScheduledRuns.js';

/** 事前確認を走らせる関数（テストでは差し替える）。 */
export type ParadisScheduledRunPrecheckRunner = (request: {
	readonly command: string;
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}) => Promise<IParadisScheduledRunPrecheckResult>;

/** 出力の末尾として持っておく長さ（伏せる前。伏せ字の形が境目で切れないよう、残す長さより多めに持つ）。 */
const TAIL_LENGTH = PARADIS_SCHEDULED_RUN_PRECHECK_OUTPUT_LENGTH + 512;

/** 記録に残す出力（末尾を、秘密らしい値を伏せてから切る）。 */
export function paradisScheduledRunPrecheckOutput(raw: string): string | undefined {
	const text = paradisRedactTextSecrets(raw.slice(-TAIL_LENGTH)).trim();
	return text ? text.slice(-PARADIS_SCHEDULED_RUN_PRECHECK_OUTPUT_LENGTH) : undefined;
}

/**
 * 事前確認を走らせる関数を作る。
 *
 * @param getEnv ログインシェルから解いた環境（`ParadisCachedShellEnv`）
 */
export function createParadisScheduledRunPrecheckRunner(getEnv: () => Promise<NodeJS.ProcessEnv>, onKillError?: (error: unknown) => void): ParadisScheduledRunPrecheckRunner {
	return async ({ command, cwd, timeoutMs, signal }) => {
		const startedAt = Date.now();
		const env = await getEnv();
		if (signal?.aborted) {
			return { error: 'cancelled', durationMs: 0 };
		}
		return new Promise<IParadisScheduledRunPrecheckResult>(resolve => {
			let output = '';
			let timedOut = false;
			let settled = false;
			let child: cp.ChildProcess;
			const finish = (result: Omit<IParadisScheduledRunPrecheckResult, 'durationMs' | 'output'>) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				const tail = paradisScheduledRunPrecheckOutput(output);
				resolve({ ...result, durationMs: Date.now() - startedAt, ...(tail !== undefined ? { output: tail } : {}) });
			};
			const stop = () => paradisKillChildProcessTree(child, onKillError, { processGroup: true });
			const onAbort = () => {
				stop();
				finish({ error: 'cancelled' });
			};
			try {
				child = cp.spawn(command, {
					cwd,
					env,
					shell: true,
					windowsHide: true,
					stdio: ['ignore', 'pipe', 'pipe'],
					// POSIX では自分のプロセスグループで起こす（止めるときにグループごと止める）。Windows では新しい
					// コンソールを開くので付けない（ツリーごと止める）
					...(process.platform === 'win32' ? {} : { detached: true }),
				});
			} catch (error) {
				resolve({ error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt });
				return;
			}
			const timer = setTimeout(() => {
				timedOut = true;
				stop();
				finish({ timedOut: true });
			}, timeoutMs);
			signal?.addEventListener('abort', onAbort);
			const append = (chunk: Buffer) => {
				output = (output + chunk.toString('utf8')).slice(-TAIL_LENGTH);
			};
			child.stdout?.on('data', append);
			child.stderr?.on('data', append);
			child.on('error', error => finish({ error: error.message }));
			child.on('close', (code, signalName) => {
				if (timedOut) {
					return;
				}
				finish(typeof code === 'number' ? { exitCode: code } : { error: `terminated by ${signalName ?? 'signal'}` });
			});
		});
	};
}
