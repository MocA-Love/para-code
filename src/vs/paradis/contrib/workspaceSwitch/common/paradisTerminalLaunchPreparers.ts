/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルを作る直前（PTY を起こす前）に、fork の機能が起動設定へ手を入れるための口。
//
// upstream の `TerminalInstanceService.createInstance` はすべての生成経路が通るチョークポイントで、
// そこにだけ1行の PARA-PATCH を置き、中身はここへ登録した関数に任せる。機能ごとに upstream の
// 行を増やさないためと、「パネルかエディタか」（`target`）を知っているのがそこだけだからである。
//
// 置き場所が workspaceSwitch なのは、upstream のターミナルから fork を import してよい先として
// eslint（`code-import-patterns`）が既に許しているため。使っている機能（共通ターミナルの開始
// フォルダ、スペースごとのシェル履歴）もどちらもスペースの扱いに関わるものである。

import { raceTimeout } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IShellLaunchConfig, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';

/**
 * 起動設定を書き換える関数。同期で、例外を投げてもターミナルの生成は止めない。
 * `shellLaunchConfig` は upstream が作ったものをそのまま渡すので、上書きしてよいのは
 * 自分の機能が責任を持つ項目（`cwd` が未指定のときの既定値、fork の環境変数など）だけにする。
 */
export type ParadisTerminalLaunchPreparer = (shellLaunchConfig: IShellLaunchConfig, target: TerminalLocation) => void;

const preparers = new Set<ParadisTerminalLaunchPreparer>();

/** 登録した順に呼ばれる。返り値を dispose すると外れる。 */
export function paradisRegisterTerminalLaunchPreparer(preparer: ParadisTerminalLaunchPreparer): IDisposable {
	preparers.add(preparer);
	return toDisposable(() => preparers.delete(preparer));
}

/** `TerminalInstanceService.createInstance` から呼ぶ。1つが失敗しても残りは呼ぶ。 */
export function paradisPrepareTerminalLaunch(shellLaunchConfig: IShellLaunchConfig, target: TerminalLocation): void {
	for (const preparer of [...preparers]) {
		try {
			preparer(shellLaunchConfig, target);
		} catch (error) {
			onUnexpectedError(error);
		}
	}
}

// --- 繋ぎ直しに失敗して起こし直すシェル ------------------------------------------------------
//
// 復元したタブが PTY へ繋げなかったとき、upstream（`terminalProcessManager.ts`）はその場で新しい
// シェルを起こす。開始フォルダは「その瞬間ウィンドウが開いているフォルダ」から決まるので、スペースの
// 切り替え中や、別のスペースに固定した補助ウィンドウでは、タブの持ち主ではないスペースのフォルダで
// 起きる。しかもその cwd が所属の証拠として台帳へ書き戻される。
//
// 起動の直前に1行の PARA-PATCH でここを呼び、持ち主のスペースが分かればそのフォルダを `cwd` に入れる。
// 分からなければ何もしない（upstream の既定のまま）。ここは upstream のターミナルから import される
// 口なので、スペースの扱いそのものは登録された関数（workspaceSwitch の browser 層）に任せる。

/** 起こし直すシェルの手がかり。 */
export interface IParadisRestartedTerminalLaunch {
	readonly instanceId: number;
	/** 端末の nonce。revive をまたいでも変わらない（所属台帳のキー）。 */
	readonly nonce: string;
	/** リモートのバックエンドで起こすならその接続先。ローカルなら undefined。 */
	readonly remoteAuthority: string | undefined;
}

/** 起こし直すシェルの開始フォルダを返す。分からなければ undefined。 */
export type ParadisRestartedTerminalCwdResolver = (launch: IParadisRestartedTerminalLaunch) => Promise<URI | undefined>;

/**
 * 答えを待つ上限。これはタブの表示を止めている待ちなので、フォルダの確認（stat）が固まったときに
 * 起動ごと止めない。間に合わなければ upstream の既定で起こす。
 */
const PARADIS_RESTARTED_TERMINAL_CWD_TIMEOUT_MS = 2_000;

let restartedTerminalCwdResolver: ParadisRestartedTerminalCwdResolver | undefined;
const restartedTerminalInstanceIds = new Set<number>();

/** 開始フォルダを決める関数を登録する（1つだけ。後から登録した方が勝つ）。 */
export function paradisRegisterRestartedTerminalCwdResolver(resolver: ParadisRestartedTerminalCwdResolver): IDisposable {
	restartedTerminalCwdResolver = resolver;
	return toDisposable(() => {
		if (restartedTerminalCwdResolver === resolver) {
			restartedTerminalCwdResolver = undefined;
		}
	});
}

/**
 * このセッションで、繋ぎ直しに失敗してシェルを起こし直した端末か。
 *
 * 起こし直したシェルの cwd は「持ち主のスペース」ではなく「その時ウィンドウが開いていたフォルダ」
 * なので、所属の判定はこれを見て cwd より容れ物（出てきた working set）を先に引く。
 */
export function paradisWasTerminalShellRestarted(instanceId: number): boolean {
	return restartedTerminalInstanceIds.has(instanceId);
}

/** 端末が閉じられたら呼ぶ。 */
export function paradisForgetRestartedTerminal(instanceId: number): void {
	restartedTerminalInstanceIds.delete(instanceId);
}

/**
 * `terminalProcessManager.ts` の「attach に失敗したので新しいシェルを起こす」分岐から、
 * `attachPersistentProcess` を消す前に呼ぶ。例外は外へ出さない（ターミナルの起動を止めない）。
 */
export async function paradisPrepareRestartedTerminalLaunch(shellLaunchConfig: IShellLaunchConfig, instanceId: number, nonce: string, remoteAuthority: string | undefined): Promise<void> {
	restartedTerminalInstanceIds.add(instanceId);
	const resolver = restartedTerminalCwdResolver;
	// 呼び出し側が開始フォルダを決めているならそれを尊重する。
	if (resolver === undefined || hasCwd(shellLaunchConfig)) {
		return;
	}
	try {
		const cwd = await raceTimeout(resolver({ instanceId, nonce, remoteAuthority }), PARADIS_RESTARTED_TERMINAL_CWD_TIMEOUT_MS);
		if (cwd !== undefined && !hasCwd(shellLaunchConfig)) {
			shellLaunchConfig.cwd = cwd;
		}
	} catch (error) {
		onUnexpectedError(error);
	}
}

function hasCwd(shellLaunchConfig: IShellLaunchConfig): boolean {
	return typeof shellLaunchConfig.cwd === 'string' ? shellLaunchConfig.cwd.length > 0 : shellLaunchConfig.cwd !== undefined;
}

/** テスト用。モジュールの状態を初期化する。 */
export function paradisResetRestartedTerminalsForTest(): void {
	restartedTerminalCwdResolver = undefined;
	restartedTerminalInstanceIds.clear();
}
