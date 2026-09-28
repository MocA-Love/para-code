/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルの「持ち主のスペース」と「そのスペースのフォルダ」を結び付けるための純粋な判定。
//
// 使う場面は3つ:
// - 復元したタブが PTY へ繋げずシェルを起こし直すとき、持ち主のスペースのフォルダで起こす
// - 別のスペースに固定した補助ウィンドウで新しく開くターミナルを、そのスペースのフォルダで起こす
// - 持ち主のスペースと作業フォルダが食い違うターミナルを一覧にする

import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisTerminalScopeRoot, paradisResolveInitialCwdScope } from './paradisTerminalProcessScope.js';

/**
 * 起こし直すシェルの持ち主を決める手がかり。上から順に、根拠の強いもの。
 * どれも「推測（今アクティブなスペース）」を含まないこと。
 */
export interface IParadisRestartedShellScopeEvidence {
	/** 今セッションで確定済みの所属（推測や同居グループからの借り物は除いて渡す）。 */
	readonly recorded?: string;
	/** park 台帳。そのスペースの持ち物として明示的に待避した履歴。 */
	readonly parked?: string;
	/** nonce 台帳（ID 台帳と食い違えば ID 台帳の値）。 */
	readonly ledger?: string;
	/** 今まさに復元している working set の持ち主（復元コンテキスト）。 */
	readonly restoreContext?: string;
	/** 端末を初めて見たときに控えた、出てきた working set の持ち主。 */
	readonly workingSet?: string;
	/** 別のスペースに固定した補助ウィンドウに居るなら、そのスペース。 */
	readonly pinnedWindow?: string;
}

/** 手がかりを根拠の強い順に引く。どれも無ければ undefined（upstream の既定に任せる）。 */
export function paradisPickRestartedShellScope(evidence: IParadisRestartedShellScopeEvidence): string | undefined {
	return evidence.recorded
		?? evidence.parked
		?? evidence.ledger
		?? evidence.restoreContext
		?? evidence.workingSet
		?? evidence.pinnedWindow;
}

/**
 * 起こし直したシェルの所属を記録するときに使う根拠。
 *
 * 起こし直したシェルの cwd は「そのとき開いていたフォルダ」で決まっている（持ち主のフォルダで
 * 起こせた回は、その持ち主が `restartOwner` として先に効く）。cwd を容れ物より先に採ると、切り替え
 * 元のフォルダが所属の証拠として nonce 台帳へ焼き付く。容れ物や固定ウィンドウが無いとき（起動時の
 * メインウィンドウ）だけ、従来どおり cwd を使う。
 */
export function paradisRestartedShellRecordScope(input: {
	readonly restartOwner?: string;
	readonly workingSet?: string;
	readonly pinnedWindow?: string;
}): string | undefined {
	return input.restartOwner ?? input.workingSet ?? input.pinnedWindow;
}

/** スペース1件（状態キーとフォルダ）。 */
export interface IParadisSpaceFolder {
	readonly stateKey: string;
	readonly uri: URI;
}

/**
 * 状態キーのフォルダを、起こそうとしているバックエンドで使える形のときだけ返す。
 * ローカルのシェルにリモートのフォルダを渡すと起動に失敗するので、合わなければ undefined。
 */
export function paradisSpaceFolderForBackend(stateKey: string, spaces: readonly IParadisSpaceFolder[], remoteAuthority: string | undefined): URI | undefined {
	const space = spaces.find(candidate => candidate.stateKey === stateKey);
	if (space === undefined) {
		return undefined;
	}
	if (remoteAuthority === undefined) {
		return space.uri.scheme === Schemas.file ? space.uri : undefined;
	}
	return space.uri.scheme === Schemas.vscodeRemote && space.uri.authority.toLowerCase() === remoteAuthority.toLowerCase() ? space.uri : undefined;
}

/**
 * upstream の `terminal.integrated.cwd` を決めている人には手を出さない。
 * そちらを決めていると upstream は新しいターミナルを全部そのフォルダで開くので、スペースの
 * フォルダを入れると「設定したのに効かない」になる。
 */
export function paradisUpstreamCwdConfigured(value: unknown): boolean {
	return typeof value === 'string' && value.trim().length > 0;
}

/** 所属と作業フォルダが食い違うターミナル1本の判定材料。 */
export interface IParadisTerminalSpaceMismatchInput {
	readonly instanceId: number;
	/** 記録上の持ち主。 */
	readonly stateKey: string | undefined;
	/** 今の作業フォルダ（分からなければ undefined）。 */
	readonly cwd: string | undefined;
}

export interface IParadisTerminalSpaceMismatch {
	readonly instanceId: number;
	readonly stateKey: string;
	/** 作業フォルダが属しているスペース。 */
	readonly cwdStateKey: string;
}

/**
 * 作業フォルダが別の登録済みスペースの中にあるターミナルを拾う。
 * 作業フォルダがどのスペースにも属さない（ホーム等）ものは拾わない。そこへ移る理由が無いため。
 */
export function paradisFindTerminalSpaceMismatches(terminals: readonly IParadisTerminalSpaceMismatchInput[], roots: readonly IParadisTerminalScopeRoot[]): IParadisTerminalSpaceMismatch[] {
	const result: IParadisTerminalSpaceMismatch[] = [];
	for (const terminal of terminals) {
		if (terminal.stateKey === undefined) {
			continue;
		}
		const cwdStateKey = paradisResolveInitialCwdScope(terminal.cwd, roots);
		if (cwdStateKey !== undefined && cwdStateKey !== terminal.stateKey) {
			result.push({ instanceId: terminal.instanceId, stateKey: terminal.stateKey, cwdStateKey });
		}
	}
	return result;
}

// --- 所属の問い合わせ口 ------------------------------------------------------------------
//
// 所属台帳を持っているのは `ParadisTerminalWorkspaceScope` だけで、それは AfterRestored まで
// 立ち上がらない。開始フォルダを決める側（BlockRestore）がそのサービスを DI で掴むと、起動時の
// 復元より前にインスタンス化させてしまい、復元の索引（`paradisRegisterTerminalReviveIndexSource`）
// まで早まって挙動が変わる。そこで、立ち上がったサービスが自分で問い合わせ口を登録する。
// 立ち上がる前の問い合わせは「分からない」になる。

export type ParadisRestartedShellScopeLookup = (instanceId: number, nonce: string) => string | undefined;

let restartedShellScopeLookup: ParadisRestartedShellScopeLookup | undefined;

export function paradisRegisterRestartedShellScopeLookup(lookup: ParadisRestartedShellScopeLookup): IDisposable {
	restartedShellScopeLookup = lookup;
	return toDisposable(() => {
		if (restartedShellScopeLookup === lookup) {
			restartedShellScopeLookup = undefined;
		}
	});
}

/** 登録が無ければ undefined。 */
export function paradisLookupRestartedShellScope(instanceId: number, nonce: string): string | undefined {
	return restartedShellScopeLookup?.(instanceId, nonce);
}
