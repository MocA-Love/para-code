/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナル(pty デーモン)の生き死にの判断。
//
// 常駐にすると、アプリが終わっても残るプロセスができる。**残るということは、居座れるという
// こと**でもある。ここに集めてあるのは「どれを片付けてよく、どれを片付けてはいけないか」の
// 判断だけで、実際に殺す・消すといった副作用は呼び出し側に置く。
//
// 通す原則は1つだけ。
//
//   **抱えているものが分からない常駐は、殺さない。**
//
// 常駐が抱えているのは動いているシェルで、その中身は数時間走らせたビルドかもしれないし、
// 途中まで進んだエージェントかもしれない。片付け損ねた常駐が居座る害は「メモリを数十MB
// 使う」で済むが、片付けてよいと誤判定した害は「取り返しのつかない作業の消失」になる。
// 天秤が最初から傾いているので、迷ったら残してユーザーに見せる (`Surface`)。
//
// 逆に、**何も抱えていないと確認できた常駐は黙って片付ける**。ここでいちいち尋ねると、
// 更新のたびにダイアログが出るだけの機能になる。

import { PARADIS_TERMINAL_RECONNECTION_GRACE_TIME } from '../../remoteTerminals/common/paradisTerminalGraceTime.js';

/**
 * クライアントが1つも居なくなってから、抱えているターミナルを片付けるまでの猶予。
 *
 * **SSH 側と同じ値を使う**。ローカルと接続先で「翌日戻ってきたら残っているか」が違うと、
 * ユーザーはどちらの流儀だったかを覚えていられない。片方だけ延ばす理由も無い。
 */
export const PARADIS_DAEMON_TERMINAL_GRACE_TIME = PARADIS_TERMINAL_RECONNECTION_GRACE_TIME;

/**
 * 何も抱えていない常駐が、自分から終わるまでの待ち時間。
 *
 * 0 にしない理由: ウィンドウを閉じてすぐ開き直す使い方で、毎回常駐を作り直すことになる
 * (起動はタダではないうえ、その隙間に2つ立ち上がる余地を作る)。長くしない理由: 何も
 * 抱えていない常駐は、ユーザーから見ると「終了したはずなのに残っているプロセス」でしかない。
 */
export const PARADIS_DAEMON_IDLE_TIMEOUT = 10 * 60 * 1000;

/** 台帳に書く1件。常駐が自分で書き、次に起動したアプリが読む。 */
export interface IParadisPtyDaemonRecord {
	readonly pid: number;
	readonly socketPath: string;
	/** 人が読めるビルドの名前。UI にそのまま出す。 */
	readonly buildId: string;
	/** ソケット名に使った短い鍵。自分のものかどうかはこれで見る。 */
	readonly buildKey: string;
	readonly startedAt: number;
}

/** 台帳の1件に対して、これから何をするか。 */
export const enum ParadisDaemonAction {
	/** 残骸を片付ける。プロセスはもう居ない。 */
	Discard,
	/** 繋いで再利用する。自分と同じビルドで生きている。 */
	Adopt,
	/** 繋いで中身を見てから決め直す。別のビルドで生きている。 */
	Inspect,
	/** 終了させる。何も抱えていないと確認できた常駐。 */
	Reap,
	/** 触らずユーザーに見せる。抱えているか、生きているのに応答しない。 */
	Surface,
}

/**
 * 台帳を読んだ直後の判断。**繋ぐ前**なので、分かるのはプロセスが居るかどうかだけ。
 *
 * ここで `Discard` を返すのは「pid が居ない」ときに限る。pid は使い回されるので、居ることは
 * 同一性の証明にならない。証明は接続の成否に任せる ({@link paradisJudgeUnreachableDaemon})。
 */
export function paradisProbeDaemonRecord(
	record: IParadisPtyDaemonRecord,
	ownBuildKey: string,
	isProcessAlive: boolean,
): ParadisDaemonAction {
	if (!isProcessAlive) {
		return ParadisDaemonAction.Discard;
	}
	return record.buildKey === ownBuildKey ? ParadisDaemonAction.Adopt : ParadisDaemonAction.Inspect;
}

/**
 * 繋いで中身が分かった、別ビルドの常駐をどうするか。
 *
 * 抱えていなければ黙って終了させる (更新のたびに古い常駐が積み上がるのを防ぐ)。1本でも
 * 抱えていれば触らない。**更新前に残したターミナルはこちら側に居る**ので、ここで殺すのは
 * 「更新したら作業が消えた」と同じ意味になる。
 */
export function paradisJudgeForeignDaemon(terminalCount: number): ParadisDaemonAction {
	return terminalCount === 0 ? ParadisDaemonAction.Reap : ParadisDaemonAction.Surface;
}

/**
 * 繋がらなかった常駐をどうするか。
 *
 * pid も居ないなら、ただの残骸なので片付ける。pid は居るのに応答しない場合は**何も分からない**
 * ので触らない。ソケットのファイルだけ消えた、常駐が固まっている、pid が使い回されて無関係の
 * プロセスになっている、のどれでもあり得る。どれであっても、こちらから殺してよい根拠は無い。
 */
export function paradisJudgeUnreachableDaemon(isProcessAlive: boolean): ParadisDaemonAction {
	return isProcessAlive ? ParadisDaemonAction.Surface : ParadisDaemonAction.Discard;
}

/** 常駐が自分の終わり時を判断するために見る状態。 */
export interface IParadisDaemonIdleState {
	/** 抱えているターミナルの本数 (猶予待ちのものも含む)。 */
	readonly terminalCount: number;
	/** 繋がっているクライアントの数。 */
	readonly clientCount: number;
	/** 最後にクライアントが居なくなった時刻。一度も繋がれていなければ起動時刻。 */
	readonly idleSince: number;
}

/**
 * 常駐が自分から終わるべきか。
 *
 * 繋がっている間は終わらない。繋がりが無くなってからの待ち時間だけが、抱えているかどうかで
 * 変わる。抱えていなければ {@link PARADIS_DAEMON_IDLE_TIMEOUT}、抱えていれば
 * {@link PARADIS_DAEMON_TERMINAL_GRACE_TIME}。
 *
 * **抱えている間は終わらない、にしてはいけない。** 猶予タイマー
 * (`PersistentTerminalProcess._disconnectRunner`) を動かすのは、クライアントが `detachFromProcess`
 * を呼んだときだけで、アプリが正常に終わらなかった場合 (クラッシュ・強制終了・電源断) には
 * 届かない。そのとき「抱えているから終わらない」と読むと、猶予タイマーも回らず自分も終われず、
 * **誰も繋いでいないのに永久に居座る常駐**ができる。常駐にした以上、上限はこちら側にも要る。
 *
 * `idleSince` に起動時刻も入れてあるのは、**一度も繋がれないまま放置された常駐**を拾うため。
 * アプリが起動直後に落ちると、起こされた常駐だけが残る。これを「クライアントが切れたことが
 * ない＝まだ待つべき」と読むと、同じく永久に居座る。
 */
export function paradisShouldDaemonExit(state: IParadisDaemonIdleState, now: number): boolean {
	if (state.clientCount > 0) {
		return false;
	}
	const limit = state.terminalCount > 0 ? PARADIS_DAEMON_TERMINAL_GRACE_TIME : PARADIS_DAEMON_IDLE_TIMEOUT;
	return now - state.idleSince >= limit;
}

/**
 * 台帳の1件を読む。壊れていれば undefined。
 *
 * 台帳はプロセスが不意に死ぬ場所で書かれるので、**書きかけが残っている前提**で読む。ここで
 * 例外を投げると、常駐の仕組みそのものではなくアプリの起動が壊れる。
 */
export function paradisParseDaemonRecord(value: unknown): IParadisPtyDaemonRecord | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const raw = value as Partial<IParadisPtyDaemonRecord>;
	if (typeof raw.pid !== 'number' || !isFinite(raw.pid) || raw.pid <= 0) {
		return undefined;
	}
	if (typeof raw.socketPath !== 'string' || raw.socketPath.length === 0) {
		return undefined;
	}
	if (typeof raw.buildId !== 'string' || raw.buildId.length === 0) {
		return undefined;
	}
	if (typeof raw.buildKey !== 'string' || raw.buildKey.length === 0) {
		return undefined;
	}
	if (typeof raw.startedAt !== 'number' || !isFinite(raw.startedAt)) {
		return undefined;
	}
	return {
		pid: raw.pid,
		socketPath: raw.socketPath,
		buildId: raw.buildId,
		buildKey: raw.buildKey,
		startedAt: raw.startedAt,
	};
}
