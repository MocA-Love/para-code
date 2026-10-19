/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Office の worker（Word・Excel の詳しい解析、Office v1）が起動できない・途中で落ちる・中で解析に失敗した
// ことを Sentry へ送る。配布版で 3 本とも起動のたびに落ちていたのに、1 件も届いていなかったため
// （呼び出し側は「解析できなかった」としか受け取らず、表示は解析に頼らないので誰も気付かなかった）。
//
// 送るのは、どの worker か・段階・失敗の種類（と終了コード）だけ。ファイル名・パス・中身・エラーの文は
// 送らない（ERR_MODULE_NOT_FOUND の文には入れ先のパスが入る）。同じ組は 1 起動に 1 回まで。

import { reportParadisDiagnosticError, paradisSafeErrorName, type ParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { createParadisWorker, type ParadisWorker } from '../../../../node/paradisWorker.js';
import type { WorkerOptions } from 'worker_threads';

/** どの worker か。 */
export type ParadisOfficeWorkerName = 'word-semantic' | 'spreadsheet-semantic' | 'spreadsheet-parse' | 'spreadsheet-metafile' | 'office-v1';

/**
 * 失敗した段階。`create` は Worker を作れなかった、`load` は何も返さないうちに落ちた（入口や npm
 * パッケージを読めない）、`run` は返し始めた後で落ちた、`exit` はこちらが止めていないのに 0 以外で終わった、
 * `analysis` は worker の中で解析が例外で止まった（呼び出し側には `failed` だけが返る）。
 */
export type ParadisOfficeWorkerFailureStage = 'create' | 'load' | 'run' | 'exit' | 'analysis';

const safeKind = /^[A-Za-z][\w.-]{0,49}$/;

/** 例外を、パスや文を含まない種類の名前にする。worker の中でも、shared process でも使う。 */
export function paradisOfficeWorkerFailureKind(error: unknown): string {
	try {
		const code = error && typeof error === 'object' ? (error as { readonly code?: unknown }).code : undefined;
		if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
			const message = error instanceof Error ? error.message : '';
			// 文の中身（パス・パッケージ名）は使わず、どちらの形かだけを見る。
			return message.startsWith('Cannot find package') ? 'missing-package' : message.startsWith('Cannot find module') ? 'missing-module' : 'module-not-found';
		}
		if (code === 'ERR_WORKER_OUT_OF_MEMORY') {
			return 'out-of-memory';
		}
		if (typeof code === 'string' && /^(?:ERR_[A-Z0-9_]{1,46}|E[A-Z]{2,14})$/.test(code)) {
			return code;
		}
	} catch {
		// 種類が分からないときは名前で返す。
	}
	return paradisSafeErrorName(error);
}

const reported = new Set<string>();

/** 1 件送る。同じ worker・段階・種類の組は、この起動の間は 2 回目から送らない。 */
export function reportParadisOfficeWorkerFailure(
	worker: ParadisOfficeWorkerName,
	stage: ParadisOfficeWorkerFailureStage,
	kind: string,
	exitCode?: number,
	reporter: ParadisDiagnosticReporter = reportParadisDiagnosticError,
): void {
	const safe = safeKind.test(kind) ? kind : 'unknown';
	const key = `${worker}|${stage}|${safe}`;
	if (reported.has(key)) {
		return;
	}
	reported.add(key);
	try {
		// エラーの文は決まった語だけにする（Sentry は文のハッシュで束ねるので、入れ先ごとに分かれないように）。
		reporter('owned', 'office-workers', `${worker}.${stage}`, new Error(`${worker} ${stage} ${safe}`), {
			safe_worker: worker,
			safe_stage: stage,
			safe_kind: safe,
			...(exitCode !== undefined && Number.isSafeInteger(exitCode) ? { safe_exit_code: exitCode } : {}),
		}, safe === 'out-of-memory' ? 'warning' : 'error');
	} catch {
		// 報告が見ている処理を変えてはいけない。
	}
}

/** テスト用。送った組の記録を消す。 */
export function resetParadisOfficeWorkerFailureReportsForTest(): void {
	reported.clear();
}

/** 見張る worker のうち、ここで使う部分。 */
export interface IParadisWatchedOfficeWorker {
	readonly terminateRequested: boolean;
	on(event: 'message', listener: (message: unknown) => void): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
	on(event: 'exit', listener: (code: number) => void): unknown;
}

/**
 * worker の error・exit・返事を見て、失敗を送る。返事の `cause`（worker が中の例外を
 * {@link paradisOfficeWorkerFailureKind} で種類にしたもの）があれば `analysis` として送る。
 * 見るだけで、worker の扱いは呼び出し側のまま変えない。
 */
export function watchParadisOfficeWorker(name: ParadisOfficeWorkerName, worker: IParadisWatchedOfficeWorker, reporter?: ParadisDiagnosticReporter): void {
	let replied = false;
	let crashed = false;
	worker.on('message', message => {
		replied = true;
		const cause = message && typeof message === 'object' ? (message as { readonly cause?: unknown }).cause : undefined;
		if (typeof cause === 'string') {
			reportParadisOfficeWorkerFailure(name, 'analysis', cause, undefined, reporter);
		}
	});
	worker.on('error', error => {
		crashed = true;
		if (!worker.terminateRequested) {
			reportParadisOfficeWorkerFailure(name, replied ? 'run' : 'load', paradisOfficeWorkerFailureKind(error), undefined, reporter);
		}
	});
	worker.on('exit', code => {
		if (code !== 0 && !crashed && !worker.terminateRequested) {
			reportParadisOfficeWorkerFailure(name, 'exit', 'exit-code', code, reporter);
		}
	});
}

/** 共通の入口を通して Office の worker を起こし、失敗を Sentry へ送るよう見張る。 */
export function createParadisOfficeWorker(name: ParadisOfficeWorkerName, entryPath: string, options?: Omit<WorkerOptions, 'workerData'>): ParadisWorker {
	let worker: ParadisWorker;
	try {
		worker = createParadisWorker(entryPath, options);
	} catch (error) {
		reportParadisOfficeWorkerFailure(name, 'create', paradisOfficeWorkerFailureKind(error));
		throw error;
	}
	watchParadisOfficeWorker(name, worker);
	return worker;
}
