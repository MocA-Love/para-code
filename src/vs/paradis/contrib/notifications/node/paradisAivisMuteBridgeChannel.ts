/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process 上で aivis CLI のミュート操作を実行する。実装方式は paradisRtkChannel.ts と同じ
// execFile 直叩き（shell は使わない）で、引数はここで固定構築し renderer から任意の引数は渡させない。
//
// 結果は使わない（成否だけ分かればよい）。aivis を入れていないユーザーの方が多いので、
// ENOENT も含めて失敗はすべてログだけ残して握り潰す — おやすみモードの切り替えという
// UI 操作を、外部ツールの都合でブロックしたり失敗させたりしてはいけない。
//
// ミュートは「掛け直し続ける」。aivis 側のミュートは Redis のキー1つで持たれており、
// `aivis --reboot` が `aivis-mcp:*` をまとめて消す、Redis を再起動する、といった外部の都合で
// 消える。切り替えた瞬間にしか送らないと、消えたあとは次にユーザーがおやすみモードを
// 触るまで「Para Code はおやすみ中なのに aivis は喋る」というズレが残り続ける。
//
// 掛け直すのはミュートを掛けている間だけで、解除は今までどおり切り替えの1回きりにする。
// おやすみモードがオフのときにも定期的に `--unmute` を送ると、ユーザーが自分で
// `aivis --mute` したものまで勝手に解除してしまう。Para Code が取り消してよいのは
// Para Code が掛けたミュートだけ。

import * as cp from 'child_process';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { reportParadisShellEnvDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisAivisMuteBridgeService, PARADIS_AIVIS_MUTE_BRIDGE_CHANNEL } from '../common/paradisAivisMuteBridge.js';

/** ミュート状態を切り替えるだけの短い呼び出しなので、待つ時間も短くてよい。 */
const EXEC_TIMEOUT_MS = 5_000;

/**
 * ミュートを掛け直す間隔（ms）。
 *
 * 直すのは外部要因でキーが消えたときだけなので頻度は要らない。毎回 aivis を1プロセス
 * 起動するため、短くしすぎない。
 */
const REASSERT_INTERVAL_MS = 5 * 60_000;

/** PATH 上の aivis を使う（npx 等のフォールバックは持たない）。 */
const AIVIS_COMMAND = 'aivis';

export class ParadisAivisMuteBridgeService implements IParadisAivisMuteBridgeService {

	/** dispose 時に停止する実行中の子プロセス。 */
	private readonly activeChildren = new Set<cp.ChildProcess>();
	private disposed = false;
	/**
	 * 掛け続けるべきミュート。`undefined` なら掛けていない。
	 * `until` が `undefined` なら「自分で解除するまで」。
	 */
	private desiredMute: { readonly until: number | undefined } | undefined;
	/** ミュートを掛け直すためのタイマー。 */
	private reassertTimer: ReturnType<typeof setInterval> | undefined;
	/**
	 * ログインシェル由来の解決済み環境（PATH 等）。shared process は Dock/Spotlight 起動の
	 * electron-main から process.env を継承するだけなので、GUI 起動では ~/.zshrc 等が足す PATH が
	 * 反映されず、PATH 上にあるはずの 'aivis' が ENOENT になりうる。
	 */
	private readonly cachedShellEnv: ParadisCachedShellEnv;

	constructor(
		private readonly logService: ILogService,
		configurationService?: IConfigurationService,
		args?: NativeParsedArgs,
		private readonly execFile: typeof cp.execFile = cp.execFile,
		private readonly now: () => number = Date.now,
		private readonly scheduleReassert: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval> = setInterval,
		private readonly cancelReassert: (handle: ReturnType<typeof setInterval>) => void = clearInterval,
	) {
		this.cachedShellEnv = new ParadisCachedShellEnv(
			logService,
			'ParadisAivisMuteBridge',
			createParadisShellEnvResolver(logService, configurationService, args),
			Date.now,
			reportParadisShellEnvDiagnosticError,
		);
	}

	async sync(enabled: boolean, remainingMs: number | undefined): Promise<void> {
		if (!enabled) {
			this.stopReasserting();
			this.desiredMute = undefined;
			await this.exec(['--unmute']);
			return;
		}
		// IPC 越しに壊れた値が来ても、時限指定の無い（＝解除されない）ミュートへ倒す。
		const timed = typeof remainingMs === 'number' && isFinite(remainingMs);
		this.desiredMute = { until: timed ? this.now() + Math.max(0, Math.round(remainingMs)) : undefined };
		this.startReasserting();
		await this.applyDesiredMute();
	}

	/** いま掛けるべきミュートを aivis へ流す。時限ミュートは毎回残り時間を計算し直す。 */
	private async applyDesiredMute(): Promise<void> {
		const desired = this.desiredMute;
		if (!desired) {
			return;
		}
		if (desired.until === undefined) {
			await this.exec(['--mute']);
			return;
		}
		const remaining = desired.until - this.now();
		if (remaining <= 0) {
			// 期限切れ。aivis 側は自前のTTLで既に解けているので、こちらは掛け直しをやめるだけ。
			// ここで `--unmute` を送ると、ユーザーが自分で掛けたミュートまで解いてしまう。
			this.stopReasserting();
			this.desiredMute = undefined;
			return;
		}
		await this.exec(['--mute', '--mute-for', `${Math.round(remaining)}ms`]);
	}

	private startReasserting(): void {
		if (this.reassertTimer !== undefined || this.disposed) {
			return;
		}
		this.reassertTimer = this.scheduleReassert(() => {
			void this.applyDesiredMute();
		}, REASSERT_INTERVAL_MS);
	}

	private stopReasserting(): void {
		if (this.reassertTimer !== undefined) {
			this.cancelReassert(this.reassertTimer);
			this.reassertTimer = undefined;
		}
	}

	private async exec(args: string[]): Promise<void> {
		if (this.disposed) {
			return;
		}
		const env = await this.cachedShellEnv.getEnv();
		return new Promise<void>(resolve => {
			const execution: { child?: cp.ChildProcess; completed: boolean } = { completed: false };
			execution.child = this.execFile(AIVIS_COMMAND, args, {
				encoding: 'utf8',
				timeout: EXEC_TIMEOUT_MS,
				windowsHide: true,
				env: { ...env, NO_COLOR: '1' }
			}, (err, _stdout, stderr) => {
				execution.completed = true;
				if (execution.child) {
					this.activeChildren.delete(execution.child);
				}
				if (err) {
					if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
						// aivis-mcp を使っていない環境。正常系として扱う。
						this.logService.trace('[ParadisAivisMuteBridge] aivis コマンドが見つかりません（同期をスキップします）');
					} else {
						this.logService.trace(`[ParadisAivisMuteBridge] aivis ${args.join(' ')} に失敗しました: ${stderr || err.message}`);
					}
				}
				resolve();
			});
			if (!execution.completed && execution.child) {
				this.activeChildren.add(execution.child);
			}
		});
	}

	dispose(): void {
		this.disposed = true;
		this.stopReasserting();
		this.desiredMute = undefined;
		for (const child of this.activeChildren) {
			try {
				child.kill();
			} catch (error) {
				this.logService.trace(`[ParadisAivisMuteBridge] dispose 中の子プロセス停止に失敗しました: ${error}`);
			}
		}
		this.activeChildren.clear();
	}
}

export class ParadisAivisMuteBridgeChannel<TContext = string> implements IServerChannel<TContext> {

	constructor(private readonly service: ParadisAivisMuteBridgeService) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'sync': {
				const remainingMs = typeof args[1] === 'number' ? args[1] : undefined;
				return this.service.sync(Boolean(args[0]), remainingMs) as Promise<T>;
			}
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/**
 * sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。
 * aivis は手元のマシンに入っているツールなので、接続先(REH)側には生やさない。
 */
export function registerParadisAivisMuteBridge(server: IPCServer<string>, logService: ILogService, configurationService: IConfigurationService, args: NativeParsedArgs): IDisposable {
	const service = new ParadisAivisMuteBridgeService(logService, configurationService, args);
	server.registerChannel(PARADIS_AIVIS_MUTE_BRIDGE_CHANNEL, new ParadisAivisMuteBridgeChannel<string>(service));
	return { dispose: () => service.dispose() };
}
