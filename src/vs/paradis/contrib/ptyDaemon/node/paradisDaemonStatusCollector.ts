/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの状態を、台帳のある機械の上で集める。
//
// **「どの機械の話か」だけを外から受け取る。** 常駐はこの PC にも SSH の接続先にも居て、
// 台帳の場所と、いま使っている常駐の鍵が違うだけで、集め方も止め方も同じものになる。
// ここを両者で共有していないと、接続先の状態を出そうとした側が接続の作り直しや期限の扱いを
// 書き直すことになり、**同じ機能が2つの微妙に違う挙動を持つ**。
//
// ここに置いたのは `node/` 層。台帳を読むのもソケットへ繋ぐのもファイルとプロセスの話なので、
// Electron の main からも REH サーバーからも同じものを呼べる場所に要る。
//
// 止める・立て直すの確認は**置かない**。ここは言われたことをするだけで、確認は画面側の仕事。
// ここに置くと、コマンドや将来の別経路から確認なしで呼べてしまう。

import { raceTimeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Client as SocketClient } from '../../../../base/parts/ipc/common/ipc.net.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisPtyDaemonControl, IParadisPtyDaemonDescription } from '../common/paradisPtyDaemonControl.js';
import { IParadisPtyDaemonRecord } from '../common/paradisPtyDaemonPolicy.js';
import {
	IParadisForeignDaemonInfo,
	IParadisPtyDaemonStatus,
	paradisGroupTerminalsBySpace,
} from '../common/paradisPtyDaemonStatus.js';
import { paradisReadDaemonRecords } from './paradisPtyDaemonLedger.js';
import { ParadisControlOpen, paradisOpenDaemonControl } from './paradisPtyDaemonControlClient.js';
import { paradisAskDaemonToStop } from './paradisPtyDaemonStop.js';

/**
 * どこを見るか。
 *
 * `ledgerDirs` は**画面に出す範囲と止められる範囲を一致させるため**に複数受け取る。
 * 切り替えの途中では旧い常駐が別の台帳に居るので、片方しか見ないと「出るが止められない」
 * (あるいは出ないまま端末を抱え続ける) になる。
 */
export interface IParadisDaemonLedgerScope {
	readonly ledgerDirs: readonly string[];
	/** いま使う常駐の鍵。これ以外の生きている記録は「別ビルドの常駐」として並べる。 */
	readonly activeBuildKey: string;
}

/** 状態を聞いたときの返事を待つ上限。閉じる処理には関わらないが、画面が凍るのを防ぐ。 */
const DESCRIBE_TIMEOUT = 3_000;

function isProcessAlive(pid: number): boolean {
	try {
		// シグナル 0 は送らずに存在だけ確かめる。権限が無い相手は EPERM になるが、
		// 「居る」ことは分かるので生存として扱う。
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string }).code === 'EPERM';
	}
}

export class ParadisDaemonStatusCollector extends Disposable {

	/**
	 * 常駐へ繋いだままにする制御用の接続。
	 *
	 * 数を聞くたびに繋ぎ直さないのは、接続のたびに常駐側へ後始末されない `Protocol` が
	 * 溜まるため (`IPCServer` は切断時にチャネルは畳むが Protocol は畳まない)。30秒ごとに
	 * 増え続けるのは避ける。
	 */
	private control: { readonly client: SocketClient<string>; readonly service: IParadisPtyDaemonControl; readonly pid: number } | undefined;

	/**
	 * 進行中の接続。
	 *
	 * 番人が要るのは、**開いている最中がまるごと競合の窓**だから。繋ぐのに最大2秒、名乗り合いに
	 * 1往復かかる間に別の呼び出しが来ると、両方が別々のソケットを開く。状態を聞く口はウィンドウ
	 * ごとに2つあるので (ステータスバーと終了ポリシー)、ウィンドウが同時に立ち上がれば普通に
	 * 重なる。後から据えた方で上書きすると先に開いた接続は誰も畳まず、しかも**畳んでも常駐側の
	 * `Protocol` は残る**ので、{@link control} が避けようとしているものがそのまま起きる。
	 * 開くこと自体を1本に畳む。
	 */
	private openingControl: { readonly pid: number; readonly opening: Promise<ParadisControlOpen> } | undefined;

	/** 進行中の問い合わせ。返事を待っている間に次を投げないための番人（{@link describeDaemon}）。 */
	private pendingDescribe: Promise<IParadisPtyDaemonDescription> | undefined;

	constructor(private readonly logService: ILogService) {
		super();
	}

	/**
	 * いま動いている常駐の姿。
	 *
	 * 返すのは「有効な場合」の中身だけ。設定で無効な機械の扱いは呼び出し側が決める
	 * (この PC と接続先で、何をもって有効とするかが違うため)。
	 */
	async collect(scope: IParadisDaemonLedgerScope): Promise<IParadisPtyDaemonStatus> {
		// **画面に出したものは止められなければならない。** 一覧は渡された台帳すべてから作るので、
		// 探す側 ({@link stopActive}) も同じ範囲を見る。片方だけだと「出るが止められない」になる。
		const records = await this.allRecords(scope);
		const own = records.find(record => record.buildKey === scope.activeBuildKey && isProcessAlive(record.pid));

		// **`listProcesses()` では数えられない。** あちらは `isOrphan` で絞るので、ウィンドウが
		// 繋がっているターミナル (つまり普通に使っている最中のもの) は1本も出てこない。常駐へ
		// 直接聞く。
		// **聞けなかったときは undefined のまま返す。** `[]` で初期化すると本数が 0 になり、
		// 受け取る側は「本当に0本」と区別できない。
		let terminals: readonly { readonly workspaceName: string }[] | undefined;
		if (own) {
			try {
				terminals = (await this.describeDaemon(own)).terminals;
			} catch (error) {
				// 繋がっていないか、常駐が固まっている。分からないままにする。
				this.logService.trace('[ParadisPtyDaemon] could not ask the daemon what it holds', error);
			}
		}

		return {
			enabled: true,
			running: own !== undefined,
			pid: own?.pid,
			buildId: own?.buildId,
			startedAt: own?.startedAt,
			terminalCount: terminals?.length,
			spaces: terminals ? paradisGroupTerminalsBySpace(terminals) : [],
			foreign: this.describeForeign(records, scope.activeBuildKey),
		};
	}

	/**
	 * 常駐に、いま何を抱えているかを聞く。接続は保ったまま使い回す。
	 *
	 * 返事にも上限を置く。繋ぐところだけ上限を付けても、**繋がったのに答えない**常駐
	 * (固まっている場合) には効かない。上限が無いと `collect()` が解決しないまま、
	 * 定期更新の待ちが積み上がってパネルが古い値で凍る。
	 */
	private async describeDaemon(record: IParadisPtyDaemonRecord): Promise<IParadisPtyDaemonDescription> {
		const { control } = await this.ensureControl(record);

		// **同じ問いを重ねない。** 上限は待つのをやめるだけで、投げた要求は相手に残る
		// (`raceTimeout` は元の約束を止めない)。待たずに次を投げると、固まっている常駐の
		// チャネルへ要求が数秒ごとに1本ずつ積み上がる。接続を使い回しているのは溜めないため
		// なので、ここで溜めては元も子もない。
		let pending = this.pendingDescribe;
		if (!pending) {
			pending = control.describe();
			this.pendingDescribe = pending;
			const settled = pending;
			// 後始末は別の枝で。ここで拒否を拾っておかないと、期限切れで誰も待っていない
			// ときに未処理の rejection になる。
			settled.then(() => { }, () => { }).finally(() => {
				if (this.pendingDescribe === settled) {
					this.pendingDescribe = undefined;
				}
			});
		}

		const described = await raceTimeout(pending, DESCRIBE_TIMEOUT);
		if (!described) {
			throw new Error(`the daemon at ${record.socketPath} did not answer in time`);
		}
		return described;
	}

	/**
	 * 制御用の接続を用意する。相手が入れ替わっていたら繋ぎ直す。
	 *
	 * pid が変わったら別の常駐なので、前の接続は捨てる。名乗り合いも毎回通す (繋がることは
	 * 身元の証明にならない)。
	 *
	 * **話し相手そのものを返さず、入れ物に入れて返す。** 理由は
	 * {@link paradisOpenDaemonControl} の冒頭に書いた。ここを `Promise<IParadisPtyDaemonControl>`
	 * にしていたために、実機で状態パネルが最初の値のまま凍り続けた。
	 */
	private async ensureControl(record: IParadisPtyDaemonRecord): Promise<{ readonly control: IParadisPtyDaemonControl }> {
		if (this.control && this.control.pid === record.pid) {
			return { control: this.control.service };
		}

		let opening = this.openingControl;
		if (!opening || opening.pid !== record.pid) {
			this.disposeControl();
			const started = { pid: record.pid, opening: paradisOpenDaemonControl(record.socketPath, record.token) };
			this.openingControl = started;
			// 後始末は別の枝で。ここで拒否を拾わないと、開けなかったときに未処理の rejection になる。
			started.opening.then(() => { }, () => { }).finally(() => {
				if (this.openingControl === started) {
					this.openingControl = undefined;
				}
			});
			opening = started;
		}

		const opened = await opening.opening;
		if (!opened.ok) {
			throw new Error(opened.reason === 'unreachable'
				? `nothing answered at ${record.socketPath}`
				: `whatever answers at ${record.socketPath} is not one of ours`);
		}
		this.seatControl(opened.client, opened.control, opening.pid);
		return { control: opened.control };
	}

	/**
	 * 開いた接続を据える。**同じ約束を待っていた全員がここを通る**ので、二重に据えない。
	 *
	 * 据える前に前の相手を畳むので、どの順で来ても掴みっぱなしにはならない。
	 */
	private seatControl(client: SocketClient<string>, control: IParadisPtyDaemonControl, pid: number): void {
		if (this.control?.client === client) {
			return;
		}
		this.disposeControl();
		this.control = { client, service: control, pid };
		// 相手が落ちたら捨てる。掴んだままだと、次の常駐へ繋ぎ直さずに黙って失敗し続ける。
		client.onDidDispose(() => {
			if (this.control?.client === client) {
				this.control = undefined;
			}
		});
	}

	private disposeControl(): void {
		this.control?.client.dispose();
		this.control = undefined;
	}

	override dispose(): void {
		this.disposeControl();
		super.dispose();
	}

	/**
	 * 見えるところにある常駐の記録すべて。
	 *
	 * 切り替えの途中では、いま使う方の台帳だけでは足りない（もう片方が端末を抱えたまま残る）。
	 */
	private async allRecords(scope: IParadisDaemonLedgerScope): Promise<IParadisPtyDaemonRecord[]> {
		const records: IParadisPtyDaemonRecord[] = [];
		for (const dir of scope.ledgerDirs) {
			records.push(...await paradisReadDaemonRecords(dir));
		}
		return records;
	}

	/**
	 * 別ビルドの常駐を説明する。
	 *
	 * 本数までは踏み込まない。聞くには繋ぐ必要があり、繋ぐと相手のクライアント数が増えて
	 * **アイドル終了の待ち時間が延びる**（自分から終わろうとしていた常駐を、様子を見ただけで
	 * 引き止めることになる）。画面に必要なのは「残っている」ことと、いつからかだけ。
	 */
	private describeForeign(records: readonly IParadisPtyDaemonRecord[], ownBuildKey: string): IParadisForeignDaemonInfo[] {
		const foreign: IParadisForeignDaemonInfo[] = [];
		for (const record of records) {
			if (record.buildKey === ownBuildKey || !isProcessAlive(record.pid)) {
				continue;
			}
			foreign.push({
				pid: record.pid,
				buildId: record.buildId,
				startedAt: record.startedAt,
				terminalCount: undefined,
			});
		}
		return foreign;
	}

	/** いま使っている常駐を止める。抱えているターミナルは全部失われる。 */
	async stopActive(scope: IParadisDaemonLedgerScope): Promise<void> {
		const records = await this.allRecords(scope);
		const own = records.find(record => record.buildKey === scope.activeBuildKey);
		if (!own) {
			return;
		}
		await this.askToStop(own.socketPath, own.token);
	}

	/**
	 * 別ビルドの常駐を止める。
	 *
	 * 受け取った pid は**そのままでは使わない**。台帳を読み直して、その pid の record が今も
	 * あることを確かめ、繋ぎ先はその record が名乗るソケットにする。渡された番号をそのまま
	 * 信じると、呼び出し側の間違いや古い画面の情報で、関係のない相手に手を出すことになる。
	 */
	async stopForeign(scope: IParadisDaemonLedgerScope, pid: number): Promise<void> {
		const records = await this.allRecords(scope);
		const record = records.find(candidate => candidate.pid === pid && candidate.buildKey !== scope.activeBuildKey);
		if (!record) {
			this.logService.info(`[ParadisPtyDaemon] no ledger entry for pid ${pid} any more; nothing to stop`);
			return;
		}
		await this.askToStop(record.socketPath, record.token);
	}

	/**
	 * 常駐へ終了を頼む。実体は `paradisPtyDaemonStop.ts`（本物のソケット相手に確かめられる
	 * ようにするため切り出してある）。ここは結果を記録するだけ。
	 */
	private async askToStop(socketPath: string, token: string): Promise<void> {
		const outcome = await paradisAskDaemonToStop(socketPath, token);
		switch (outcome) {
			case 'stopped':
				this.logService.info(`[ParadisPtyDaemon] the daemon at ${socketPath} took the stop request`);
				return;
			case 'unreachable':
				this.logService.warn(`[ParadisPtyDaemon] nothing answered at ${socketPath}; leaving it alone`);
				return;
			case 'not-ours':
				this.logService.warn(`[ParadisPtyDaemon] whatever answers at ${socketPath} is not one of ours; leaving it alone`);
				return;
			case 'timeout':
				this.logService.warn(`[ParadisPtyDaemon] the daemon at ${socketPath} did not act on the stop request in time`);
				return;
		}
	}
}
