/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの状態を、画面に出せる形にまとめたもの。
//
// 常駐にすると、ユーザーから見て**アプリの外に見えないものが増える**。閉じたはずのターミナルが
// 動いているかもしれないし、更新前の常駐が残っているかもしれない。どちらも「言われなければ
// 気づけない」ので、状態を一箇所にまとめて画面へ出す。
//
// 出す側の原則は、モックを見て決めたとおり **平常時に色を使わない**。常駐しているのは異常では
// なく既定の状態で、色は「放っておくと損をする」ときのために取っておく。

import { localize } from '../../../../nls.js';

export const PARADIS_PTY_DAEMON_CHANNEL = 'paradisPtyDaemon';

/** スペースごとの本数。ポップオーバーの一覧に出す。 */
export interface IParadisDaemonSpaceCount {
	readonly name: string;
	readonly count: number;
}

/** 自分とは別のビルドの常駐。更新後にだけ現れる。 */
export interface IParadisForeignDaemonInfo {
	readonly pid: number;
	readonly buildId: string;
	readonly startedAt: number;
	/** 抱えている本数。**応答しない相手では undefined**（分からないことを 0 と書かない）。 */
	readonly terminalCount: number | undefined;
}

export interface IParadisPtyDaemonStatus {
	/** 設定で有効になっているか。false なら何も出さない。 */
	readonly enabled: boolean;
	/** いま実際に常駐へ繋がっているか。 */
	readonly running: boolean;
	readonly pid: number | undefined;
	readonly buildId: string | undefined;
	readonly startedAt: number | undefined;
	/**
	 * 抱えている本数。**常駐に聞けなかったときは undefined。**
	 *
	 * `number` にして 0 を入れてはいけない。受け取る側から「本当に0本」と「聞けなかった」が
	 * 区別できなくなり、20本抱えている常駐に対して「0本」「失うものはありません」と言って
	 * 停止させることになる。分からないことは分からないと持ち回る。
	 */
	readonly terminalCount: number | undefined;
	/** スペースごとの内訳。聞けなかったときは空（本数の undefined と合わせて読むこと）。 */
	readonly spaces: readonly IParadisDaemonSpaceCount[];
	readonly foreign: readonly IParadisForeignDaemonInfo[];
}

export interface IParadisPtyDaemonStatusService {
	getStatus(): Promise<IParadisPtyDaemonStatus>;
	/** 止めて立て直す。抱えているターミナルは全部失われる。 */
	restart(): Promise<void>;
	/** 止める。抱えているターミナルは全部失われる。 */
	stop(): Promise<void>;
	/** 別ビルドの常駐を止める。 */
	stopForeign(pid: number): Promise<void>;
}

/** ステータスバーに色を付けるか。平常時は付けない。 */
export type ParadisDaemonSeverity = 'none' | 'warn' | 'error';

/**
 * 画面での強さを決める。
 *
 * `error` は「作業が失われた」ときだけ。設定を有効にしたのに常駐へ繋がっていない状態が
 * それにあたる（アプリの中の pty host へ落ちているので、次に閉じたらターミナルは消える）。
 * `warn` は「放っておくと損をする」。更新前の常駐が残っているのがこれで、放っておくと
 * 見えないところでメモリを抱え続ける。
 */
export function paradisDaemonSeverity(status: IParadisPtyDaemonStatus): ParadisDaemonSeverity {
	if (!status.enabled) {
		return 'none';
	}
	if (!status.running) {
		return 'error';
	}
	return status.foreign.length > 0 ? 'warn' : 'none';
}

/**
 * 稼働時間の表し方。
 *
 * 秒は出さない。ここを見る人が知りたいのは「いつからか」であって正確な長さではないので、
 * 1秒ごとに数字が動くと、読めないうえに再描画の理由が増えるだけになる。
 */
export function paradisFormatUptime(milliseconds: number): string {
	if (!isFinite(milliseconds) || milliseconds < 0) {
		return localize('paradis.ptyDaemon.uptime.unknown', "不明");
	}
	const minutes = Math.floor(milliseconds / 60_000);
	if (minutes < 1) {
		return localize('paradis.ptyDaemon.uptime.justNow', "1分未満");
	}
	if (minutes < 60) {
		return localize('paradis.ptyDaemon.uptime.minutes', "{0}分", minutes);
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return localize('paradis.ptyDaemon.uptime.hours', "{0}時間", hours);
	}
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours === 0
		? localize('paradis.ptyDaemon.uptime.days', "{0}日", days)
		: localize('paradis.ptyDaemon.uptime.daysHours', "{0}日 {1}時間", days, restHours);
}

/** 一覧に出すときのスペース名。名前を持たないターミナルをまとめる先。 */
export function paradisSpacelessLabel(): string {
	return localize('paradis.ptyDaemon.spaceless', "スペースなし");
}

/**
 * ターミナルをスペースごとにまとめる。
 *
 * 本数の多い順に並べ、同数なら名前順。名前を持たないものは1つにまとめて最後に置く
 * （数が多くても、これは「どこの作業か分からない集まり」なので上に来ても嬉しくない）。
 */
export function paradisGroupTerminalsBySpace(
	terminals: readonly { readonly workspaceName: string }[],
): IParadisDaemonSpaceCount[] {
	const counts = new Map<string, number>();
	let spaceless = 0;
	for (const terminal of terminals) {
		const name = terminal.workspaceName?.trim();
		if (!name) {
			spaceless++;
			continue;
		}
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const grouped = Array.from(counts, ([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
	if (spaceless > 0) {
		grouped.push({ name: paradisSpacelessLabel(), count: spaceless });
	}
	return grouped;
}

/** 画面に出すビルドの名前。コミットは頭だけにする。 */
export function paradisShortBuildId(buildId: string | undefined): string {
	if (!buildId) {
		return '—';
	}
	// `<version>-<commit>` の形。コミットは40文字あり、そのまま出すと桁が読めなくなるうえ、
	// 折り返して欄が縦に伸びる。見分けがつけば十分なので頭だけにする。
	const separator = buildId.indexOf('-');
	if (separator === -1) {
		return buildId;
	}
	const commit = buildId.slice(separator + 1);
	// **切るのはコミットハッシュだけ。** 長さだけで切ると、`1.132.0-paracode-72` と
	// `1.132.0-paracode-73` がどちらも `1.132.0-paracode` に潰れる。古い常駐と新しい常駐を
	// 見分けるための表示なので、潰れた時点で用を成さない。
	if (!/^[0-9a-f]{32,}$/.test(commit)) {
		return buildId;
	}
	return `${buildId.slice(0, separator)}-${commit.slice(0, 8)}`;
}
