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
 * 起こし直すシェルの持ち主を決める手がかり。どれも「推測（今アクティブなスペース）」を含まないこと。
 */
export interface IParadisRestartedShellScopeEvidence {
	/** 今まさに復元している working set の持ち主（復元コンテキスト）。 */
	readonly restoreContext?: string;
	/** 端末を初めて見たときに控えた、出てきた working set の持ち主。 */
	readonly workingSet?: string;
	/** park 台帳。そのスペースの持ち物として明示的に待避した履歴。 */
	readonly parked?: string;
	/**
	 * nonce 台帳。pid 台帳は渡さないこと。attach に失敗したばかりの ID は何世代も前の番号で
	 * あり得て、前回たまたま同じ番号だった別のスペースの端末の所属を拾う。
	 */
	readonly ledger?: string;
	/** 今セッションで確定済みの所属（推測や同居グループからの借り物は除いて渡す）。 */
	readonly recorded?: string;
	/** 別のスペースに固定した補助ウィンドウに居るなら、そのスペース。 */
	readonly pinnedWindow?: string;
}

/**
 * 手がかりを根拠の強い順に引く。どれも無ければ undefined（upstream の既定に任せる）。
 *
 * 「このタブがどの working set から出てきたか」を最初に見る。今セッションの確定値は、復元の
 * 直後に pid 台帳から引いた値であり得る（上の `ledger` の注意と同じ理由で外れうる）ので後に回す。
 */
export function paradisPickRestartedShellScope(evidence: IParadisRestartedShellScopeEvidence): string | undefined {
	return evidence.restoreContext
		?? evidence.workingSet
		?? evidence.parked
		?? evidence.ledger
		?? evidence.recorded
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

/** 所属・容れ物・作業フォルダの食い違いを見るターミナル1本の判定材料。 */
export interface IParadisTerminalSpaceReviewInput {
	readonly instanceId: number;
	/** 記録上の持ち主。 */
	readonly stateKey: string | undefined;
	/**
	 * タブが今どのスペースの画面に居るか（エディタのタブだけ。メインウィンドウなら今のスペース、
	 * 固定した補助ウィンドウならそのスペース）。パネルは undefined。
	 */
	readonly container: string | undefined;
	/** 今の作業フォルダ（分からなければ undefined）。 */
	readonly cwd: string | undefined;
}

/**
 * 食い違いを直す操作。
 * - `claim`: タブが居るスペースの持ち物に直す（フォルダはそのまま）
 * - `move`: 作業フォルダのスペースへ移す（タブもそのスペースへ行く）
 * - `cd`: 持ち主のスペースのまま、そのスペースのフォルダへ移る（持ち主が容れ物と違えば容れ物に直す）
 */
export type ParadisTerminalSpaceAction =
	| { readonly kind: 'claim'; readonly stateKey: string }
	| { readonly kind: 'move'; readonly stateKey: string }
	| { readonly kind: 'cd'; readonly stateKey: string };

export interface IParadisTerminalSpaceReview {
	readonly instanceId: number;
	readonly stateKey: string | undefined;
	readonly container: string | undefined;
	readonly cwdStateKey: string | undefined;
	readonly actions: readonly ParadisTerminalSpaceAction[];
}

/**
 * 所属・タブの居場所・作業フォルダが揃っていないターミナルと、その直し方を挙げる。
 *
 * 取り違えは2通りある。「所属は正しいがシェルだけ別のスペースのフォルダに居る」と、「所属も
 * フォルダも別のスペースに焼き付き、タブだけ元のスペースに居る」。前者は所属と cwd を比べれば
 * 見つかるが、後者は所属と cwd が一致しているので、タブの居場所と比べないと見つからない。
 * どちらが正しいかはユーザーにしか分からないので、直し方は候補として並べるだけにする。
 * 作業フォルダがどのスペースにも属さない（ホーム等）ことは食い違いとみなさない。
 */
export function paradisReviewTerminalSpaces(terminals: readonly IParadisTerminalSpaceReviewInput[], roots: readonly IParadisTerminalScopeRoot[]): IParadisTerminalSpaceReview[] {
	const result: IParadisTerminalSpaceReview[] = [];
	for (const terminal of terminals) {
		const cwdStateKey = paradisResolveInitialCwdScope(terminal.cwd, roots);
		const owner = terminal.container ?? terminal.stateKey;
		const actions: ParadisTerminalSpaceAction[] = [];
		if (terminal.container !== undefined && terminal.container !== terminal.stateKey) {
			actions.push({ kind: 'claim', stateKey: terminal.container });
		}
		if (owner !== undefined && cwdStateKey !== undefined && cwdStateKey !== owner) {
			actions.push({ kind: 'cd', stateKey: owner });
		}
		if (cwdStateKey !== undefined && cwdStateKey !== terminal.stateKey && (terminal.stateKey !== undefined || terminal.container !== undefined)) {
			actions.push({ kind: 'move', stateKey: cwdStateKey });
		}
		if (actions.length > 0) {
			result.push({ instanceId: terminal.instanceId, stateKey: terminal.stateKey, container: terminal.container, cwdStateKey, actions });
		}
	}
	return result;
}

/**
 * フォルダへ移るコマンドを、シェルが展開も解釈もしない形で作る。作れなければ undefined。
 *
 * upstream の `preparePathForShell` は使わない。`C#` や `R&D` の文字を落とし、`'` を含むパスで
 * 継続入力に入り、WSL では引用しないため、そのまま Enter を送ると別のことが起きうる。
 * - POSIX 系（bash / zsh / sh / ksh / Git Bash / WSL）: 単一引用符で囲み、`'` は `'\''`
 * - fish: 同じ形に加え、単一引用符の中でも効く `\` を重ねる
 * - PowerShell: `Set-Location -LiteralPath '...'`。`'` と、単一引用符として扱われる U+2018〜U+201B を重ねる
 * - cmd: `cd /d "..."`。二重引用符の中でも `%VAR%` が展開されるので、`%` や `"` を含むパスは作らない
 * - それ以外（csh の `!` 履歴展開、不明なシェル等）は作らない
 */
export function paradisChangeDirectoryCommand(shellType: string | undefined, path: string): string | undefined {
	if (path.length === 0 || /[\r\n\u0000]/.test(path)) {
		return undefined;
	}
	switch (shellType) {
		case 'bash':
		case 'zsh':
		case 'sh':
		case 'ksh':
		case 'gitbash':
		case 'wsl':
			return `cd '${path.replace(/'/g, `'\\''`)}'`;
		case 'fish':
			return `cd '${path.replace(/\\/g, '\\\\').replace(/'/g, `'\\''`)}'`;
		case 'pwsh':
			return `Set-Location -LiteralPath '${path.replace(/['\u2018\u2019\u201a\u201b]/g, quote => quote + quote)}'`;
		case 'cmd':
			return /[%"]/.test(path) ? undefined : `cd /d "${path}"`;
		default:
			return undefined;
	}
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
