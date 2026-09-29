/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 下部パネルの「共通ターミナル」（どのスペースにも属さないターミナル）の設定と判定。
//
// ふだんのターミナルはエディタのタブとしてスペースごとに持ち替わる。下部パネルのターミナルだけは
// スペースを切り替えても退避せず、スペースを消しても消えない共通の置き場にする。

import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IShellLaunchConfig, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';

/** 下部パネルのターミナルをスペース共通にするか。変更はウィンドウの再読み込み後に反映する。 */
export const PARADIS_TERMINAL_SHARED_PANEL_ENABLED = 'paradis.terminal.sharedPanel.enabled';

/** 共通ターミナルを新しく開くときのフォルダ。空ならホームフォルダ。 */
export const PARADIS_TERMINAL_SHARED_PANEL_CWD = 'paradis.terminal.sharedPanel.cwd';

/** 設定値を真偽に直す。未設定（既定値の読み込み前を含む）は有効として扱う。 */
export function paradisIsTerminalSharedPanelEnabled(value: unknown): boolean {
	return value !== false;
}

let sharedPanelAtStartup: boolean | undefined;

/**
 * 共通ターミナルを使うか。**ウィンドウで最初に読んだ値をそのまま使い続ける**（変更は再読み込みで
 * 反映）。所属の判定・パネルの開閉・開始フォルダ・シェル履歴の4か所が、途中で設定が変わっても
 * 食い違わないよう、読むのはここ1か所にする。
 */
export function paradisSharedPanelEnabledAtStartup(configurationService: { getValue(key: string): unknown }): boolean {
	sharedPanelAtStartup ??= paradisIsTerminalSharedPanelEnabled(configurationService.getValue(PARADIS_TERMINAL_SHARED_PANEL_ENABLED));
	return sharedPanelAtStartup;
}

/** テスト用。起動時の値の控えを捨てる。 */
export function paradisResetSharedPanelStartupValueForTest(): void {
	sharedPanelAtStartup = undefined;
}

/** 起動設定、または復元時の attach 情報から読む、そのターミナルの素性。 */
interface IParadisSharedPanelShellLike {
	readonly type?: string;
	readonly hideFromUser?: boolean;
	readonly isFeatureTerminal?: boolean;
	readonly isExtensionOwnedTerminal?: boolean;
	readonly customPtyImplementation?: unknown;
	readonly attachPersistentProcess?: { readonly type?: string; readonly hideFromUser?: boolean; readonly isFeatureTerminal?: boolean };
}

/**
 * 共通ターミナルとして扱ってよい種類か（ユーザーが開いたシェルだけ）。
 *
 * タスク・拡張機能・機能用（feature）・隠し（hideFromUser）のターミナルは、そのスペースの作業の
 * 一部なので従来どおりスペースに属させ、スペースを削除したら一緒に閉じる。復元したターミナルは
 * 起動設定から種類が落ちているので、attach 情報の側も見る。
 */
export function paradisIsSharedPanelShell(config: IParadisSharedPanelShellLike): boolean {
	const attach = config.attachPersistentProcess;
	return config.type !== 'Task' && attach?.type !== 'Task'
		&& config.hideFromUser !== true && attach?.hideFromUser !== true
		&& config.isFeatureTerminal !== true && attach?.isFeatureTerminal !== true
		&& config.isExtensionOwnedTerminal !== true
		&& config.customPtyImplementation === undefined;
}

/**
 * この起動設定に共通ターミナルの開始フォルダを入れてよいか。
 *
 * 触るのは「パネルに新しく作る、フォルダの指定が無いシェル」だけ。分割（親の cwd を継ぐ）や
 * フォルダを選んで開いた場合、タスク・拡張機能・復元（attach）のターミナルは、呼び出し元が
 * 決めた場所をそのまま使う。拡張機能が作るターミナルも、拡張機能はワークスペースのフォルダで
 * 開く前提で作っているので触らない。
 */
export function paradisShouldApplySharedPanelCwd(shellLaunchConfig: IShellLaunchConfig, target: TerminalLocation): boolean {
	return target === TerminalLocation.Panel
		&& shellLaunchConfig.cwd === undefined
		&& shellLaunchConfig.attachPersistentProcess === undefined
		// 接続先のウィンドウで開く「手元のターミナル」（type: 'Local'）は、接続先のホームで開けない。
		&& shellLaunchConfig.type === undefined
		&& paradisIsSharedPanelShell(shellLaunchConfig);
}

/**
 * 設定値から開始フォルダを決める。
 *
 * - 空: ホームフォルダ
 * - `~` / `~/...`: ホームフォルダからの相対
 * - 絶対パス: そのまま（接続先がある場合は接続先のパスとして扱う）
 * - それ以外の相対パス: ホームフォルダからの相対
 *
 * ホームフォルダの URI をそのまま土台にするので、SSH 接続中は接続先のフォルダになる。
 */
export function paradisResolveSharedPanelCwd(configured: unknown, userHome: URI): URI {
	const value = typeof configured === 'string' ? configured.trim() : '';
	if (value.length === 0 || value === '~') {
		return userHome;
	}
	if (value.startsWith('~/') || value.startsWith('~\\')) {
		return joinPath(userHome, value.slice(2));
	}
	const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(value);
	if (value.startsWith('/') || isWindowsAbsolute) {
		return userHome.scheme === Schemas.file
			? URI.file(value)
			: userHome.with({ path: isWindowsAbsolute ? `/${value.replace(/\\/g, '/')}` : value });
	}
	return joinPath(userHome, value);
}

/** 共通ターミナルへ移したシェルが「一度も使われていない空のシェル」かの判定材料。 */
export interface IParadisIdleShellState {
	/** シェル統合が効いているか。効いていなければ中で何が起きたか分からないので対象外。 */
	readonly hasShellIntegration: boolean;
	/** 子プロセスが居るか（エージェントやサーバーが動いている）。 */
	readonly hasChildProcesses: boolean;
	/** このシェルで実行したコマンドの数（前のセッションから引き継いだ分を含む）。 */
	readonly commandCount: number;
	/** 実行中のコマンドがあるか。 */
	readonly isExecuting: boolean;
	/** プロンプトに打ちかけの文字があるか。 */
	readonly hasPendingInput: boolean;
	/** タブの見出し。前面で何か（エージェント等）が動いていると、シェル名以外になる。 */
	readonly title: string;
	/**
	 * 前のシェルへそのまま繋ぎ直した端末か。画面ごと起こし直したもの（PC の再起動後の復元）や、
	 * 繋ぎ直せず新しいシェルを起こしたものは false。そういう端末はコマンドの履歴を持たないので、
	 * 使われていたかどうかをコマンド数で判断できない。
	 */
	readonly reattachedToSameShell: boolean;
	/** プロンプトより上にある、空でない行の数。プロンプトの位置が分からなければ undefined。 */
	readonly nonEmptyLinesBeforePrompt: number | undefined;
	/** 画面（スクロールバックを含む）にある空でない行の数。読めなければ undefined。 */
	readonly nonEmptyLines: number | undefined;
}

/** プロンプトの位置が分からないとき、プロンプトだけと見なしてよい行数（2 行のプロンプトまで）。 */
const PARADIS_IDLE_SHELL_MAX_PROMPT_LINES = 2;

/**
 * 閉じてよい空のシェルか。消えると戻せないので、どれか1つでも分からない・当てはまらないなら閉じない。
 *
 * 更新前のバージョンでは、スペースを行き来するたびにパネルへ空のシェルが1本ずつ作られていた
 * （パネルの表示を戻す処理が、パネルのターミナルを戻す処理より先に走っていたため）。溜まった分は
 * 共通ターミナルへ移した時点でまとめて並ぶ。その片付けに使う。
 */
export function paradisIsIdleEmptyShell(state: IParadisIdleShellState): boolean {
	return state.hasShellIntegration
		&& !state.hasChildProcesses
		&& state.commandCount === 0
		&& !state.isExecuting
		&& !state.hasPendingInput
		// 子プロセスの有無は、繋ぎ直した直後は pty host から届くまで「無し」に見える。見出しでも確かめる。
		&& /^(?:zsh|bash|fish|sh|dash|ksh|nu|pwsh|powershell|cmd)(?:\.exe)?$/i.test(state.title.trim())
		&& state.reattachedToSameShell
		// 画面にプロンプト以外の行があれば、何かに使われていた。
		&& (state.nonEmptyLinesBeforePrompt !== undefined
			? state.nonEmptyLinesBeforePrompt === 0
			: state.nonEmptyLines !== undefined && state.nonEmptyLines <= PARADIS_IDLE_SHELL_MAX_PROMPT_LINES);
}

/**
 * 共通ターミナルの nonce の控えの上限。古いものから捨てる（閉じた端末の nonce は孤児として
 * 二度と現れないので、残っていても害は無く、上限で自然に消える）。
 */
export const PARADIS_SHARED_PANEL_NONCES_MAX = 500;

/** 控えを読む。壊れていれば空。 */
export function paradisParseSharedPanelNonces(raw: string | undefined): string[] {
	if (raw === undefined) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string' && value.length > 0) : [];
	} catch {
		return [];
	}
}

/**
 * 控えに足す。既にあれば undefined（書き込みを省く。同じ端末は所属を見直すたびにここへ来る）。
 * 上限を超えたら先に控えたものから捨てる。
 */
export function paradisRememberSharedPanelNonce(nonces: readonly string[], nonce: string, max: number = PARADIS_SHARED_PANEL_NONCES_MAX): string[] | undefined {
	if (nonces.includes(nonce)) {
		return undefined;
	}
	return [...nonces, nonce].slice(-max);
}

/** 控えから外す（エディタのタブへ移した等）。無ければ undefined。 */
export function paradisForgetSharedPanelNonce(nonces: readonly string[], nonce: string): string[] | undefined {
	return nonces.includes(nonce) ? nonces.filter(value => value !== nonce) : undefined;
}

/**
 * どのウィンドウにも繋がっていない PTY（孤児）を、共通ターミナルとしてパネルへ戻すか。
 *
 * 共通ターミナルはどのスペースにも属さないので、スペースの台帳で所属を引けない。引けないまま
 * 飛ばすと、常駐ターミナルが生かし続ける見えないシェルになる。戻すのは「共通ターミナルだった」と
 * 控えてある nonce のものだけにする。所属が分からないだけの端末（エディタのタブの端末で台帳に
 * 書けなかったもの等）まで拾うと、そのタブが後で繋ぎに来たときに取り合いになる。
 */
export function paradisShouldReviveSharedPanelOrphan(input: {
	readonly sharedPanel: boolean;
	/** スペースの台帳で引けた所属。引けたなら共通ターミナルではない。 */
	readonly stateKey: string | undefined;
	readonly nonce: string | undefined;
	readonly sharedPanelNonces: ReadonlySet<string>;
	readonly detail: { readonly type?: string; readonly hideFromUser?: boolean; readonly isFeatureTerminal?: boolean };
}): boolean {
	return input.sharedPanel
		&& input.stateKey === undefined
		&& input.nonce !== undefined
		&& input.sharedPanelNonces.has(input.nonce)
		&& paradisIsSharedPanelShell({ attachPersistentProcess: input.detail });
}
