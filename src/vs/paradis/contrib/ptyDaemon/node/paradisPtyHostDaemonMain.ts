/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 薄い常駐そのもの。**アプリのコードをほとんど読み込まない**独立したプロセスとして起きる。
//
// 前の常駐はアプリの pty ホスト一式（`IPtyService` の実装）を丸ごと起こしていた。だから
// アプリのバンドルの中のコードを実行しており、更新でバンドルが差し替わると足元が変わる恐れが
// あった。こちらが読み込むのは pty を抱える部分と ipc だけで、**アプリの版とは無関係に動ける**。
//
// 寿命の決め方（台帳への名乗り、身元の証明、抱えていないときの引き上げ）は前の常駐と同じ
// 仕組みを使い回す。**そこは常駐が2種類あっても同じ判断**なので、別々に書くと必ずずれる。

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisPtyDaemonEnv } from '../common/paradisPtyDaemonEnv.js';
import { PARADIS_PTY_HOST_CHANNEL, PARADIS_PTY_HOST_CLIENT } from '../common/paradisPtyProtocol.js';
import { paradisSpawnNodePty } from './paradisNodePtySpawner.js';
import { ParadisPtyDaemonHost } from './paradisPtyDaemonHost.js';
import { paradisRunPtyDaemonLifecycle } from './paradisPtyDaemonLifecycle.js';
import { paradisServePtyDaemon } from './paradisPtyDaemonServer.js';

/**
 * 先回りで包ませないイベント。
 *
 * **ここを外すと、誰も読まない出力が常駐の中に無限に積み上がる。** `ProxyChannel.fromService`
 * は既定で全イベントを `Event.buffer` に包み、最初の購読者が来るまで上限なく溜める。ターミナルの
 * 生出力がそれに乗ると、実機で 20 時間 600MB という形になる（`paradisLocalPtyChannel.ts` に
 * 同じ話がある）。渡しておけば、購読されるまで元のイベントを購読すらしない。
 */
const PARADIS_UNBUFFERED_EVENTS = ['onDidChangeData', 'onDidChangeTitle', 'onDidExit'];

export interface IParadisPtyHostDaemonOptions {
	readonly env: IParadisPtyDaemonEnv;
	readonly logService: ILogService;
	/** 起きられなかったときに呼ぶ。既定は `process.exit`。テストでは差し替える。 */
	readonly exit?: (code: number) => void;
}

/**
 * 常駐を起こす。ソケットを取れなければ**何もせず引き上げる**。
 *
 * 取れないのは、たいてい他の誰かが先に取ったから。そこで無理に奪うと、**走っているターミナルを
 * 抱えたままの常駐からソケットを取り上げる**ことになり、繋ぎ直せない孤児を作る。
 */
export async function paradisRunPtyHostDaemon(options: IParadisPtyHostDaemonOptions): Promise<DisposableStore | undefined> {
	const { env, logService } = options;
	const exit = options.exit ?? ((code: number) => process.exit(code));

	const served = await paradisServePtyDaemon(env.socketPath);
	for (const note of served.notes) {
		logService.info(`[ParadisPtyHost] ${note}`);
	}
	if (served.outcome !== 'bound') {
		logService.info(`[ParadisPtyHost] someone else is serving ${env.socketPath}; standing down`);
		exit(0);
		return undefined;
	}

	const disposables = new DisposableStore();
	disposables.add(served.server);

	const host = disposables.add(new ParadisPtyDaemonHost(paradisSpawnNodePty));
	served.server.registerChannel(
		PARADIS_PTY_HOST_CHANNEL,
		ProxyChannel.fromService(host, disposables, { unbufferedEvents: PARADIS_UNBUFFERED_EVENTS }),
	);

	// **見ている相手が消えたら、繋いでいたものを離す。** アプリが行儀よく `detach` して閉じるとは
	// 限らない（落ちる・強制終了される・機械が寝る）。届かなかった場合に「まだ誰かが見ている」と
	// 思い続けると、未確認の文字が数え上がって高水位で pty が止まり、閉じている間も走り切らせる
	// という判断が無言で覆る。接続が切れたこと自体を合図にする。
	//
	// **接続の数では判断できない。** 状態パネルや停止 UI も同じソケットへ繋ぐので、アプリが
	// 動いている限り接続は 0 にならない。数で見ていた頃は、pty ホストだけが落ちても「まだ
	// 誰かが見ている」と判断してしまい、未確認の文字が数え上がって高水位で pty が止まり、
	// しかも引き取りは「見られている」ものを飛ばすので**アプリを終了するまで復帰できなかった**。
	//
	// 名乗りで見分ける。見に来た相手が消えたときだけ離す。
	disposables.add(served.server.onDidRemoveConnection(connection => {
		if (connection.ctx === PARADIS_PTY_HOST_CLIENT && !served.server.connections.some(other => other.ctx === PARADIS_PTY_HOST_CLIENT)) {
			host.releaseViewers();
		}
	}));

	disposables.add(paradisRunPtyDaemonLifecycle({
		env,
		connections: served.server,
		// スペース名は預かりものの中にある。**常駐が中身を読むのはここだけ。** 預けられた
		// 時点でほぐしてあるので、寿命を見るたびに読み直さない（1分ごとに全件を parse する
		// 必要が無い）。読めなくても本数は数えられ、寿命の判断は本数で決まる。
		heldTerminals: async () => host.heldSpaces(),
		logService,
	}));

	logService.info(`[ParadisPtyHost] serving ${env.socketPath}`);
	return disposables;
}
