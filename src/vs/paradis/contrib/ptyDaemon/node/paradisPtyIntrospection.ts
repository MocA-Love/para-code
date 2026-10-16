/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// pid から引けるものを引く。**常駐を越えずに済ませるための道具。**
//
// `IProcessPropertyMap` には `IShellLaunchConfig` のような upstream の都合で変わる形が混ざるので、
// あの面を常駐へ通すと凍結が崩れる。通さずに済むのは、必要な値の出どころが pid だから
// (`paradisPtyProtocol.ts` の冒頭)。
//
// **これが成り立つのは、常駐とアプリ側が常に同じ機械の上に居るから。** ローカルでは当然だが、
// SSH でも「アプリ側」は REH サーバーでリモート上に居るので同じ。ここが崩れる構成
// (別の機械に常駐を置く) を将来考えるなら、この前提ごと見直すことになる。

import * as fs from 'fs';
import { exec } from 'child_process';
import { isLinux, isMacintosh } from '../../../../base/common/platform.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/** 起動先の検査結果。`stat` の例外を呼び出し側へ持ち出さないための形。 */
export type ParadisPathKind = 'directory' | 'other' | 'missing';

export async function paradisStatKind(path: string): Promise<ParadisPathKind> {
	try {
		return (await fs.promises.stat(path)).isDirectory() ? 'directory' : 'other';
	} catch (error) {
		if ((error as { code?: string }).code === 'ENOENT') {
			return 'missing';
		}
		// 読めない理由が「無い」以外なら、開けるかどうかは起動してみないと分からない。
		// ここで止めると、権限の都合で stat できないだけの場所が使えなくなる。
		return 'directory';
	}
}

/** `exec` のうち使う形。テストで差し替える。 */
export type ParadisExec = (command: string, options: { env: NodeJS.ProcessEnv }, callback: (error: Error | null, stdout: string, stderr: string) => void) => void;

/**
 * `lsof` で作業ディレクトリを引けなかったことを記録した pid。
 *
 * 引けない理由の多くは「シェルが居る場所がもう無い」（消した worktree の中で開いたままのシェル
 * など）で、そのシェルが生きている限り毎回引けない。画面の保存は 5 分ごとに全部のターミナルの
 * 作業ディレクトリを引くので、記録し続けると、1 本のために同じエラーが 5 分ごとに積もる
 * （実機で 3 日に 134 回）。同じ pid では 1 回だけ記録する。pid は使い回されるが、取り違えても
 * 失うのはログの 1 行だけなので、上限を超えたら忘れるだけにする。
 */
const cwdFailureReported = new Set<number>();
const CWD_FAILURE_REPORTED_LIMIT = 1_000;

function reportCwdFailureOnce(pid: number, logService: ILogService, error: Error | null, stdout: string, stderr: string): void {
	if (cwdFailureReported.has(pid)) {
		return;
	}
	if (cwdFailureReported.size >= CWD_FAILURE_REPORTED_LIMIT) {
		cwdFailureReported.clear();
	}
	cwdFailureReported.add(pid);
	logService.error('[ParadisPtyDaemon] lsof did not run successfully, it may not be on the $PATH? (not repeated for this process)', error, stdout, stderr);
}

/**
 * いまの作業ディレクトリ。取れなければ undefined（呼び出し側が起動時の場所へ倒す）。
 *
 * 中身は upstream の `TerminalProcess.getCwd` と同じ手段。macOS で `lsof` を使うのは、
 * Big Sur 以降の Electron で spawn がスレッドを塞ぐ問題を避けるための upstream の判断で、
 * 理由ごと引き継いでいる。
 */
export async function paradisReadCwd(pid: number, logService: ILogService, execImpl: ParadisExec = exec): Promise<string | undefined> {
	// pid は「別のビルドの、別のプロセス」から届いた値。コマンドラインに混ぜる前に形を確かめる。
	// 同じユーザー同士なので権限の境界ではないが、確かめるのが安い以上、確かめない理由が無い。
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	if (isMacintosh) {
		return new Promise<string | undefined>(resolve => {
			execImpl(`lsof -OPln -p ${pid} | grep cwd`, { env: { ...process.env, LANG: 'en_US.UTF-8' } }, (error, stdout, stderr) => {
				if (!error && stdout !== '') {
					resolve(stdout.substring(stdout.indexOf('/'), stdout.length - 1));
					return;
				}
				reportCwdFailureOnce(pid, logService, error, stdout, stderr);
				resolve(undefined);
			});
		});
	}
	if (isLinux) {
		try {
			return await fs.promises.readlink(`/proc/${pid}/cwd`);
		} catch {
			return undefined;
		}
	}
	return undefined;
}
