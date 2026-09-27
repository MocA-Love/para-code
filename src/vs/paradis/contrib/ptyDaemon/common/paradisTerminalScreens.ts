/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの画面をディスクへ保存して、PC の再起動の後に戻す（TM14）。判断の部分だけ。
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
//
// 保存物には、シェルの起動条件（`shellLaunchConfig` の環境変数。秘密の変数は落とす。
// `paradisTerminalPrivateFiles.ts` の一覧）と、シェル統合の nonce が入る。**nonce からはペイント
// ークンが決まる**（エディタのタブと起こし直した端末を結び付けるのに要るので残している）。
// 書き込みは main プロセスで、本人だけが読める権限（0600、フォルダ 0700）。

/** 保存物を使わずに捨てるまでの日数。 */
export const PARADIS_TERMINAL_SCREENS_MAX_AGE_DAYS = 30;
export const PARADIS_TERMINAL_SCREENS_MAX_AGE = PARADIS_TERMINAL_SCREENS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** 保存したときに画面を抱えていた常駐。 */
export interface IParadisDaemonIdentity {
	readonly pid: number;
	readonly startedAt: number;
}

/** ファイルの形。 */
export interface IParadisSavedTerminalScreens {
	readonly version: 2;
	/** 保存した時刻。 */
	readonly savedAt: number;
	/** 保存したときに繋がっていた常駐。 */
	readonly daemon: IParadisDaemonIdentity;
	/** pty ホストの `serializeTerminalState` が返した文字列（upstream の保存物と同じ形。内部用の環境変数は落としてある）。 */
	readonly state: string;
}

export function paradisEncodeTerminalScreens(savedAt: number, daemon: IParadisDaemonIdentity, state: string): string {
	const value: IParadisSavedTerminalScreens = { version: 2, savedAt, daemon: { pid: daemon.pid, startedAt: daemon.startedAt }, state };
	return JSON.stringify(value);
}

export function paradisDecodeTerminalScreens(content: string): IParadisSavedTerminalScreens | undefined {
	try {
		const value = JSON.parse(content) as Partial<IParadisSavedTerminalScreens> | null;
		if (value && value.version === 2 && typeof value.savedAt === 'number' && typeof value.state === 'string' && value.state.length > 0
			&& typeof value.daemon?.pid === 'number' && typeof value.daemon.startedAt === 'number') {
			return { version: 2, savedAt: value.savedAt, daemon: { pid: value.daemon.pid, startedAt: value.daemon.startedAt }, state: value.state };
		}
	} catch {
		// 壊れたファイルは無かったことにする
	}
	return undefined;
}

/** 常駐の今の状態のうち、判断に要る部分（`IParadisPtyDaemonStatus` の一部）。 */
export interface IParadisDaemonStatusLike {
	/**
	 * 台帳に載っている今のビルドの常駐プロセスが生きているか。**pty ホストがその常駐を使って
	 * いるかまでは表さない**（起動に失敗してアプリの中の pty ホストに落ちた後に、常駐だけが
	 * 生きていることがある）。保存側は `terminalCount` も見て補う。
	 */
	readonly running: boolean;
	readonly pid: number | undefined;
	readonly startedAt: number | undefined;
	/** 別のビルドの常駐（更新前の常駐が、元の端末を抱えたまま残っていることがある）。 */
	readonly foreign: readonly { readonly pid: number; readonly startedAt: number }[];
	/** 今の常駐が抱えている本数。聞けなかったら undefined。 */
	readonly terminalCount?: number;
}

/**
 * 保存するときの常駐。常駐が生きていて、しかも保存しようとしている本数以上を抱えていると
 * 答えたときだけ返す。pty ホストがアプリの中に落ちている（常駐は生きているが使われていない）
 * ときは、常駐はこちらの端末を抱えていないので、ここで弾かれる。
 */
export function paradisDaemonIdentityForSaving(status: IParadisDaemonStatusLike | undefined, terminalsToSave: number): IParadisDaemonIdentity | undefined {
	const identity = paradisDaemonIdentityForSave(status);
	return identity && status?.terminalCount !== undefined && status.terminalCount >= terminalsToSave ? identity : undefined;
}

/** 今、保存してよい常駐（繋がっていて、誰かが分かる）。保存しないときは undefined。 */
export function paradisDaemonIdentityForSave(status: IParadisDaemonStatusLike | undefined): IParadisDaemonIdentity | undefined {
	return status?.running && typeof status.pid === 'number' && typeof status.startedAt === 'number'
		? { pid: status.pid, startedAt: status.startedAt }
		: undefined;
}

export const enum ParadisSavedScreensDecision {
	/** upstream の復元へ渡す。 */
	Revive = 'revive',
	/** 古すぎる。捨てる。 */
	Expired = 'expired',
	/** 保存したときの常駐がまだ動いている（プロセスは生きている）。使わない。 */
	DaemonStillHolds = 'daemonStillHolds',
	/** 常駐の状態が分からない、または今は常駐が動いておらずアプリも保存より前から動いている。二重に起こすより戻さない方を採る。 */
	Unknown = 'unknown',
}

/**
 * 保存物を使うか決める。
 *
 * - 保存したときの常駐（pid と起動時刻の組）が今の常駐か、別ビルドの常駐（更新前のもの）として
 *   生きていれば、元のプロセスはそこにあるので使わない
 * - 常駐が動いていて、保存したときの常駐がどこにも居なければ戻す（PC の再起動、24時間の放置で
 *   終了、手動の停止）
 * - 常駐が動いていない・状態が分からないときは、**アプリ（main プロセス）が保存より後に起動して
 *   いれば**戻す。保存物のプロセスを抱えうるのは保存したときの常駐か、そのとき動いていたアプリの
 *   中の pty ホストだけで、どちらも居ない（PC を再起動した直後で常駐の起動がまだ終わっていない
 *   ときがこれに当たる）。アプリが保存より前から動いているなら、ウィンドウの再読み込みで
 *   アプリの中の pty ホストがまだ端末を抱えていることがあるので戻さない
 */
export function paradisDecideSavedScreens(saved: IParadisSavedTerminalScreens, now: number, status: IParadisDaemonStatusLike | undefined, mainStartedAt?: number): ParadisSavedScreensDecision {
	if (now - saved.savedAt > PARADIS_TERMINAL_SCREENS_MAX_AGE) {
		return ParadisSavedScreensDecision.Expired;
	}
	const same = (other: { readonly pid: number; readonly startedAt: number }) => other.pid === saved.daemon.pid && other.startedAt === saved.daemon.startedAt;
	if (status && status.foreign.some(same)) {
		return ParadisSavedScreensDecision.DaemonStillHolds;
	}
	const current = paradisDaemonIdentityForSave(status);
	if (current) {
		return same(current) ? ParadisSavedScreensDecision.DaemonStillHolds : ParadisSavedScreensDecision.Revive;
	}
	return mainStartedAt !== undefined && mainStartedAt > saved.savedAt ? ParadisSavedScreensDecision.Revive : ParadisSavedScreensDecision.Unknown;
}
