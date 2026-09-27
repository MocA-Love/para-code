/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの画面をディスクへ保存して、PC の再起動の後に戻す（Q49 A / TM14）。判断の部分だけ。
//
// なぜ要るか: 常駐を使うと、アプリを閉じるときに upstream の「画面を保存して次に開いたとき
// シェルを起こし直す」（`persistTerminalState` → `reviveTerminalProcesses`）を飛ばしている
// （走っているプロセスは常駐に残るので、起こし直すと二重になる。`terminalService.ts` の
// PARA-PATCH）。ところが PC を再起動すると常駐ごと消えるので、画面もタブも戻らない。常駐を
// 使わない方が再起動に強い、という逆転が起きていた。
//
// 直し方: 常駐を使っている間は、upstream が閉じるときに1回だけ作る保存物と同じもの
// （pty ホストの `serializeTerminalState`）を定期的にディスクへ書いておく。次に開いたとき、
// **その画面を抱えていた常駐がもう居なければ**（常駐がそれより後に起動していれば）、
// upstream の復元にそのまま渡す。常駐がまだ同じなら、プロセスは生きているので使わない。

/** 保存物を使わずに捨てるまでの日数。 */
export const PARADIS_TERMINAL_SCREENS_MAX_AGE_DAYS = 30;
export const PARADIS_TERMINAL_SCREENS_MAX_AGE = PARADIS_TERMINAL_SCREENS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** ワークスペースの保存フォルダ（workspaceStorage/<id>/）に置くファイル名。 */
export const PARADIS_TERMINAL_SCREENS_FILE = 'paradisTerminalScreens.json';

/** ファイルの形。 */
export interface IParadisSavedTerminalScreens {
	readonly version: 1;
	/** 保存した時刻。 */
	readonly savedAt: number;
	/** pty ホストの `serializeTerminalState` が返した文字列そのもの（upstream の保存物と同じ形）。 */
	readonly state: string;
}

export function paradisEncodeTerminalScreens(savedAt: number, state: string): string {
	const value: IParadisSavedTerminalScreens = { version: 1, savedAt, state };
	return JSON.stringify(value);
}

export function paradisDecodeTerminalScreens(content: string): IParadisSavedTerminalScreens | undefined {
	try {
		const value = JSON.parse(content) as Partial<IParadisSavedTerminalScreens> | null;
		if (value && value.version === 1 && typeof value.savedAt === 'number' && typeof value.state === 'string' && value.state.length > 0) {
			return { version: 1, savedAt: value.savedAt, state: value.state };
		}
	} catch {
		// 壊れたファイルは無かったことにする
	}
	return undefined;
}

/** 常駐の今の状態のうち、判断に要る部分。 */
export interface IParadisDaemonIdentity {
	/** 常駐へ繋がっているか。 */
	readonly running: boolean;
	/** 常駐が起動した時刻。 */
	readonly startedAt: number | undefined;
}

export const enum ParadisSavedScreensDecision {
	/** upstream の復元へ渡す。 */
	Revive = 'revive',
	/** 古すぎる。捨てる。 */
	Expired = 'expired',
	/** 保存したときの常駐がまだ動いている（プロセスは生きている）。使わない。 */
	DaemonStillHolds = 'daemonStillHolds',
	/** 常駐の状態が分からない。二重に起こすより戻さない方を採る。 */
	Unknown = 'unknown',
}

/**
 * 保存物を使うか決める。
 *
 * 「保存したときの常駐がまだ居るか」は、常駐の起動時刻が保存時刻より前かで見る。前なら、
 * 保存した時点でその常駐が画面の持ち主だった（まだ抱えている）。後なら、常駐は保存の後に
 * 起き直している（PC の再起動、24時間の放置で終了、手動の停止）ので、保存した画面の
 * プロセスはもう無い。
 * 常駐へ繋がっていない（起動に失敗してアプリの中の pty ホストに落ちている）ときも、保存物の
 * プロセスを引き取れる相手は居ないので戻す。
 */
export function paradisDecideSavedScreens(saved: IParadisSavedTerminalScreens, now: number, daemon: IParadisDaemonIdentity | undefined): ParadisSavedScreensDecision {
	if (now - saved.savedAt > PARADIS_TERMINAL_SCREENS_MAX_AGE) {
		return ParadisSavedScreensDecision.Expired;
	}
	if (!daemon) {
		return ParadisSavedScreensDecision.Unknown;
	}
	if (!daemon.running) {
		return ParadisSavedScreensDecision.Revive;
	}
	if (daemon.startedAt === undefined) {
		return ParadisSavedScreensDecision.Unknown;
	}
	return daemon.startedAt > saved.savedAt ? ParadisSavedScreensDecision.Revive : ParadisSavedScreensDecision.DaemonStillHolds;
}
