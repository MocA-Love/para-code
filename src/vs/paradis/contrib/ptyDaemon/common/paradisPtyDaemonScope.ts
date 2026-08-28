/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの表示が、**どの機械の話をしているのか**。
//
// 常駐はこの PC にも SSH の接続先にも別々に居る。ウィンドウがどちらを見ているかは
// `remoteAuthority` で決まり、接続先を開いているウィンドウのターミナルは**接続先の常駐**が
// 抱えている。ところが表示だけがこの PC の main を見ていたため、接続先のウィンドウに
// 「この PC の常駐が12本」が出ていた。並んでいる数字がそのウィンドウのターミナルと無関係
// なだけでも困るが、本当にまずいのは同じパネルの「停止」で、押すと目の前のターミナルでは
// なく**別の機械の12本**が終わる。
//
// そこで、見ている先を最初に1つ決めて、文言と操作の両方をそれに従わせる。文言をここに
// 集めてあるのは、**画面のどこか1つだけが機械を言い忘れる**のを防ぐため（言い忘れた1箇所が
// 確認ダイアログだと、失うものを取り違えたまま押せてしまう）。
//
// この PC を見ているときの言い回しは変えない。常駐がこの PC に居るのは既定の状態で、
// そこに「この PC の」と断りを入れるのは、読む人にとって意味の無い言葉が増えるだけになる。

import { localize } from '../../../../nls.js';
import { IParadisPtyDaemonStatus } from './paradisPtyDaemonStatus.js';

export interface IParadisDaemonScope {
	/** 接続先(REH)の常駐を見ているか。 */
	readonly isRemote: boolean;
	/** 接続先の呼び名。取れなければ undefined（そのときは「接続先」とだけ言う）。 */
	readonly hostLabel: string | undefined;
}

export const PARADIS_LOCAL_DAEMON_SCOPE: IParadisDaemonScope = { isRemote: false, hostLabel: undefined };

export function paradisDaemonScopeFor(remoteAuthority: string | undefined, hostLabel: string | undefined): IParadisDaemonScope {
	if (remoteAuthority === undefined) {
		return PARADIS_LOCAL_DAEMON_SCOPE;
	}
	// 空文字は「取れなかった」と同じ扱いにする。`getHostLabel` は解決前に空を返すことがあり、
	// そのまま出すと「接続先  の常駐」になる。
	const label = hostLabel?.trim();
	return { isRemote: true, hostLabel: label ? label : undefined };
}

/** 接続先の呼び名。名前が取れていなくても、機械が違うことだけは必ず言う。 */
export function paradisDaemonHostName(scope: IParadisDaemonScope): string {
	return scope.hostLabel ?? localize('paradis.ptyDaemon.scope.host', "接続先");
}

/**
 * パネルの見出しの下に添える1行。どの機械の話かを、操作を押す前に読める場所へ置く。
 *
 * この PC を見ているときは返さない（既定の状態に断りは要らない）。
 */
export function paradisDaemonScopeLine(scope: IParadisDaemonScope): string | undefined {
	if (!scope.isRemote) {
		return undefined;
	}
	return localize('paradis.ptyDaemon.scope.line', "接続先 {0} の常駐です。この PC の常駐とは別のものです。", paradisDaemonHostName(scope));
}

export function paradisDaemonStatusTooltip(scope: IParadisDaemonScope, status: IParadisPtyDaemonStatus): string {
	if (!status.running) {
		return scope.isRemote
			? localize('paradis.ptyDaemon.status.tooltipStoppedRemote', "接続先 {0} で常駐が動いていません。いまのターミナルは接続先のサーバーの中で動いているので、サーバーが入れ替わると失われます。クリックで詳細。", paradisDaemonHostName(scope))
			: localize('paradis.ptyDaemon.status.tooltipStopped', "常駐が動いていません。いまのターミナルは Para Code の中で動いています。クリックで詳細。");
	}
	if (status.terminalCount === undefined) {
		return scope.isRemote
			? localize('paradis.ptyDaemon.status.tooltipUnknownRemote', "接続先 {0} の常駐は動いていますが、いま何を抱えているかを聞き出せていません。クリックで詳細。", paradisDaemonHostName(scope))
			: localize('paradis.ptyDaemon.status.tooltipUnknown', "常駐は動いていますが、いま何を抱えているかを聞き出せていません。クリックで詳細。");
	}
	return scope.isRemote
		? localize('paradis.ptyDaemon.status.tooltipRemote', "{0}本のターミナルを、接続先 {1} の常駐が抱えています。クリックで詳細。", status.terminalCount, paradisDaemonHostName(scope))
		: localize('paradis.ptyDaemon.status.tooltip', "{0}本のターミナルを、Para Code の外の常駐が抱えています。クリックで詳細。", status.terminalCount);
}

export function paradisDaemonStatusAria(scope: IParadisDaemonScope, status: IParadisPtyDaemonStatus): string {
	if (!status.running) {
		return scope.isRemote
			? localize('paradis.ptyDaemon.status.ariaStoppedRemote', "接続先 {0} の常駐ターミナルは停止しています", paradisDaemonHostName(scope))
			: localize('paradis.ptyDaemon.status.ariaStopped', "常駐ターミナルは停止しています");
	}
	if (status.terminalCount === undefined) {
		return scope.isRemote
			? localize('paradis.ptyDaemon.status.ariaUnknownRemote', "接続先 {0} の常駐ターミナルの本数を取得できていません", paradisDaemonHostName(scope))
			: localize('paradis.ptyDaemon.status.ariaUnknown', "常駐ターミナルの本数を取得できていません");
	}
	return scope.isRemote
		? localize('paradis.ptyDaemon.status.ariaRemote', "接続先 {0} の常駐ターミナル {1}本", paradisDaemonHostName(scope), status.terminalCount)
		: localize('paradis.ptyDaemon.status.aria', "常駐ターミナル {0}本", status.terminalCount);
}

/**
 * 確認ダイアログの見出し。
 *
 * **ここで機械を言い忘れると、取り返しのつかない操作を取り違えたまま押せる。** 失う本数は
 * 呼び出し側が本文に書くが、それがどこの本数なのかはこの一行にしか出ない。
 */
export function paradisDaemonRestartTitle(scope: IParadisDaemonScope): string {
	return scope.isRemote
		? localize('paradis.ptyDaemon.confirm.restartRemote', "接続先 {0} の常駐ターミナルを再起動しますか?", paradisDaemonHostName(scope))
		: localize('paradis.ptyDaemon.confirm.restart', "常駐ターミナルを再起動しますか?");
}

export function paradisDaemonStopTitle(scope: IParadisDaemonScope): string {
	return scope.isRemote
		? localize('paradis.ptyDaemon.confirm.stopRemote', "接続先 {0} の常駐ターミナルを停止しますか?", paradisDaemonHostName(scope))
		: localize('paradis.ptyDaemon.confirm.stop', "常駐ターミナルを停止しますか?");
}

export function paradisDaemonForeignStopTitle(scope: IParadisDaemonScope): string {
	return scope.isRemote
		? localize('paradis.ptyDaemon.confirm.foreignRemote', "接続先 {0} の古いバージョンの常駐を停止しますか?", paradisDaemonHostName(scope))
		: localize('paradis.ptyDaemon.confirm.foreign', "古いバージョンの常駐を停止しますか?");
}

/**
 * 接続先の常駐を止めるときにだけ足す注意書き。
 *
 * 接続先のサーバーには**別のクライアントも繋がっていることがある**。この PC の常駐なら失うのは
 * 自分の作業だけだが、接続先では他のウィンドウ（他の人のことさえある）の作業も一緒に終わる。
 * 押す前に知らされていないと取り返せない差なので、本文に足す。
 */
export function paradisDaemonSharedHostWarning(scope: IParadisDaemonScope): string | undefined {
	return scope.isRemote
		? localize('paradis.ptyDaemon.confirm.sharedHost', "この接続先に繋いでいる他のウィンドウのターミナルも、同じ常駐が抱えていれば一緒に終わります。")
		: undefined;
}

/**
 * パネル本体の1行。**何が起きているかを、その機械の言葉で言う。**
 *
 * この PC と接続先では、常駐が居なかったときに何が起きるかが違う。この PC ならウィンドウを
 * 閉じた時点で終わり、接続先ならサーバーが入れ替わった時点で失われる（サーバーはコミット
 * ごとに配られるので、更新するたびに入れ替わる）。同じ文で済ませると、どちらかが嘘になる。
 */
export function paradisDaemonLeadText(scope: IParadisDaemonScope, status: IParadisPtyDaemonStatus): string {
	if (!status.running) {
		return scope.isRemote
			? localize('paradis.ptyDaemon.popover.leadStoppedRemote', "接続先 {0} で常駐が動いていません。設定は有効ですが、いまはターミナルを接続先のサーバーの中で動かしています。", paradisDaemonHostName(scope))
			: localize('paradis.ptyDaemon.popover.leadStopped', "常駐が動いていません。設定は有効ですが、いまはターミナルを Para Code の中で動かしています。");
	}
	if (status.terminalCount === undefined) {
		// **「ありません」と言わない。** 聞けなかっただけで、抱えていないとは限らない。
		return localize('paradis.ptyDaemon.popover.leadUnknown', "常駐は動いていますが、いま何を抱えているかを聞き出せていません。しばらくすると取り直します。");
	}
	if (status.terminalCount === 0) {
		return localize('paradis.ptyDaemon.popover.leadIdle', "常駐は動いていますが、抱えているターミナルはありません。このまま誰も使わなければ、しばらくして自分から終了します。");
	}
	// 「残ります」と言い切らず「残せます」にしてある。閉じるときに残すかどうかは設定
	// (`keepAliveOnClose`) と、尋ねたときの答え次第で、`never` にしている人には嘘になる。
	return scope.isRemote
		? localize('paradis.ptyDaemon.popover.leadRunningRemote', "{0}本のターミナルを、接続先 {1} の常駐が抱えています。Para Code を閉じても、接続先のサーバーが入れ替わっても、実行したまま残せます。", status.terminalCount, paradisDaemonHostName(scope))
		: localize('paradis.ptyDaemon.popover.leadRunning', "{0}本のターミナルを、Para Code の外の常駐が抱えています。ウィンドウを閉じても Para Code を終了しても、実行したまま残せます。", status.terminalCount);
}

/** 常駐していないときの警告の本文。放っておくと何を失うかは、機械によって違う。 */
export function paradisDaemonNotRunningSub(scope: IParadisDaemonScope): string {
	return scope.isRemote
		? localize('paradis.ptyDaemon.popover.notRunningSubRemote', "いまのターミナルは接続先のサーバーの中で動いているので、サーバーが入れ替わると失われます。次にターミナルを開くと常駐を立て直します。")
		: localize('paradis.ptyDaemon.popover.notRunningSub', "いまのターミナルは Para Code の中で動いているので、閉じると終了します。次にターミナルを開くと常駐を立て直します。");
}
