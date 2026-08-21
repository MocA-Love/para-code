/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// アプリ側から見た1本のターミナル。`TerminalProcess` の代わりに置かれ、pty を自分では持たず
// 常駐に持たせる。差し替えは `ptyService.ts` の `new TerminalProcess(...)` 1行だけ。
//
// **`ITerminalChildProcess` の13個のうち、常駐へ渡すのは11個だけ。**
//
// 残る `refreshProperty` / `updateProperty` は `IProcessPropertyMap` を運ぶ。あれは
// `IShellLaunchConfig` などを含む「upstream の都合で変わる形」なので、常駐へ通すと凍結が
// 崩れる。ここで組み立ててしまえば通さずに済む:
//
//  - `Cwd` / `InitialCwd` / `HasChildProcesses` は pid から引く。**常駐とここは常に同じ機械の
//    上に居る**ので引ける (ローカルは当然、SSH でも「ここ」＝ REH サーバーはリモート上に居る)
//  - `Title` は pty を持つ側にしか見えないので常駐から**文字列で**受け取り、ここで型に組む
//  - `FixedDimensions` / `OverrideDimensions` はもともとこちら側の状態
//  - シェル統合の注入まわりは、**注入自体をここでやる**ので最初からこちらにある
//
// **シェル統合の注入をこちらへ寄せたのは、面を薄く保つためだけではない。** 注入するスクリプトが
// 出す OSC を読むのもアプリ側なので、出す側と読む側が別々に更新されると壊れ方が読めなくなる。
// スクリプトはアプリの中に留め、常駐へは解決し切った argv/env を渡す。

import * as fs from 'fs';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import * as path from '../../../../base/common/path.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ChildProcessMonitor } from '../../../../platform/terminal/node/childProcessMonitor.js';
import { findExecutable } from '../../../../base/node/processes.js';
import { getShellIntegrationInjection } from '../../../../platform/terminal/node/terminalEnvironment.js';
import {
	IProcessProperty,
	IProcessPropertyMap,
	IProcessReadyEvent,
	IProcessReadyWindowsPty,
	IShellLaunchConfig,
	ITerminalLaunchError,
	ITerminalLaunchResult,
	ITerminalProcessOptions,
	ProcessPropertyType,
	TerminalShellType,
} from '../../../../platform/terminal/common/terminal.js';
import { IProcessEnvironment } from '../../../../base/common/platform.js';
import { IParadisPtyHost } from '../common/paradisPtyProtocol.js';
import { IParadisTerminalProcessLike } from '../common/paradisTerminalProcessLike.js';
import { paradisReadCwd, paradisStatKind } from './paradisPtyIntrospection.js';

export class ParadisDaemonTerminalProcess extends Disposable implements IParadisTerminalProcessLike {

	id = 0;
	shouldPersist = false;

	private handle: number | undefined;
	private pid = -1;
	private initialCwd: string;

	private readonly childProcesses = this._register(new MutableDisposable<ChildProcessMonitor>());

	/**
	 * 常駐から流れてくるものの購読。**抱える相手が決まってから張る。**
	 *
	 * `_register` ではなくここに置くのは、{@link adopt} が引き取りでもう一度呼ばれ得るため。
	 * 直接登録すると、呼ばれるたびに購読が積み上がる。
	 */
	private readonly wiring = this._register(new MutableDisposable<DisposableStore>());

	private readonly _onProcessData = this._register(new Emitter<string>());
	readonly onProcessData = this._onProcessData.event;

	private readonly _onProcessReady = this._register(new Emitter<IProcessReadyEvent>());
	readonly onProcessReady = this._onProcessReady.event;

	private readonly _onDidChangeProperty = this._register(new Emitter<IProcessProperty>());
	readonly onDidChangeProperty = this._onDidChangeProperty.event;

	private readonly _onProcessExit = this._register(new Emitter<number | undefined>());
	readonly onProcessExit = this._onProcessExit.event;

	private title = '';

	constructor(
		private readonly host: IParadisPtyHost,
		readonly shellLaunchConfig: IShellLaunchConfig,
		cwd: string,
		private cols: number,
		private rows: number,
		private readonly env: IProcessEnvironment,
		private readonly executableEnv: IProcessEnvironment,
		private readonly options: ITerminalProcessOptions,
		private readonly logService: ILogService,
		private readonly productService: IProductService,
	) {
		super();
		this.initialCwd = cwd;
	}

	async start(): Promise<ITerminalLaunchError | ITerminalLaunchResult | undefined> {
		const invalid = await this.validate();
		if (invalid) {
			return invalid;
		}

		const env: IProcessEnvironment = { ...this.env };
		const injection = await getShellIntegrationInjection(this.shellLaunchConfig, this.options, env, this.logService, this.productService);
		let injectedArgs: string[] | undefined;
		if (injection.type === 'injection') {
			this._onDidChangeProperty.fire({ type: ProcessPropertyType.UsedShellIntegrationInjection, value: true });
			Object.assign(env, injection.envMixin ?? {});
			// スクリプトの持ち出しもこちら側で行う。常駐はスクリプトを知らない。
			await this.copyInjectionFiles(injection.filesToCopy);
			injectedArgs = injection.newArgs;
		} else {
			this._onDidChangeProperty.fire({ type: ProcessPropertyType.FailedShellIntegrationActivation, value: true });
			this._onDidChangeProperty.fire({ type: ProcessPropertyType.ShellIntegrationInjectionFailureReason, value: injection.reason });
			// 注入に失敗しても nonce は渡す。独自シェルでもシェル統合を使えるようにするため
			// (upstream の `TerminalProcess` と同じ判断)。
			if (this.options.shellIntegration.nonce) {
				env['VSCODE_NONCE'] = this.options.shellIntegration.nonce;
			}
		}

		const args = injectedArgs ?? this.toArgs(this.shellLaunchConfig.args);
		try {
			const summary = await this.host.spawn({
				file: this.shellLaunchConfig.executable!,
				args,
				env: paradisPlainEnv(env),
				cwd: this.initialCwd,
				cols: this.cols,
				rows: this.rows,
				metadata: '',
			});
			this.adopt(summary.handle, summary.pid, summary.title);
			await this.host.attach(summary.handle);
		} catch (error) {
			return { message: localize('paradis.ptyDaemon.launchFailed', "The terminal could not be started ({0})", String(error)) };
		}

		return injectedArgs ? { injectedArgs } : undefined;
	}

	/**
	 * 常駐が抱えている1本を、こちら側の器に結び付ける。
	 *
	 * 起こした直後にも、**更新をまたいで引き取るときにも**同じ道を通る。
	 */
	adopt(handle: number, pid: number, title: string): void {
		this.handle = handle;
		this.pid = pid;
		this.title = title;

		const monitor = new ChildProcessMonitor(pid, this.logService);
		this.childProcesses.value = monitor;

		const wiring = new DisposableStore();
		this.wiring.value = wiring;
		wiring.add(monitor.onDidChangeHasChildProcesses(value => this._onDidChangeProperty.fire({ type: ProcessPropertyType.HasChildProcesses, value })));
		wiring.add(this.host.onDidChangeData(event => {
			if (event.handle !== handle) {
				return;
			}
			this._onProcessData.fire(event.data);
			this.childProcesses.value?.handleOutput();
		}));
		wiring.add(this.host.onDidChangeTitle(event => {
			if (event.handle !== handle) {
				return;
			}
			this.title = event.title;
			this._onDidChangeProperty.fire({ type: ProcessPropertyType.Title, value: event.title });
		}));
		wiring.add(this.host.onDidExit(event => {
			if (event.handle !== handle) {
				return;
			}
			this._onProcessExit.fire(event.code);
		}));

		this._onProcessReady.fire({ pid, cwd: this.initialCwd, windowsPty: undefined });
	}

	private toArgs(args: string | string[] | undefined): string[] {
		if (args === undefined) {
			return [];
		}
		// 常駐へ渡す面は配列だけにしてある。文字列のまま渡すと、どちら側が区切るのかが
		// 曖昧になり、引用の扱いが2箇所に分かれる。
		return typeof args === 'string' ? [args] : args;
	}

	private async copyInjectionFiles(files: readonly { source: string; dest: string }[] | undefined): Promise<void> {
		for (const file of files ?? []) {
			try {
				await paradisCopyInjectionFile(file.source, file.dest);
			} catch {
				// 同じ機械を複数人で使っているとき以外は起きない。スクリプトはめったに変わらず、
				// その場合も同じ版を使っているはずなので、既にあるものを信じて進む
				// (upstream の `TerminalProcess` と同じ判断)。
			}
		}
	}

	private async validate(): Promise<ITerminalLaunchError | undefined> {
		const kind = await paradisStatKind(this.initialCwd);
		if (kind === 'missing') {
			return { message: localize('paradis.ptyDaemon.cwdMissing', "Starting directory (cwd) \"{0}\" does not exist", this.initialCwd) };
		}
		if (kind !== 'directory') {
			return { message: localize('paradis.ptyDaemon.cwdNotDirectory', "Starting directory (cwd) \"{0}\" is not a directory", this.initialCwd) };
		}
		this._onDidChangeProperty.fire({ type: ProcessPropertyType.InitialCwd, value: this.initialCwd });

		const slc = this.shellLaunchConfig;
		if (!slc.executable) {
			throw new Error('IShellLaunchConfig.executable not set');
		}
		const cwd = slc.cwd instanceof URI ? slc.cwd.path : slc.cwd;
		const envPaths = slc.env?.PATH ? slc.env.PATH.split(path.delimiter) : undefined;
		const executable = await findExecutable(slc.executable, cwd, envPaths, this.executableEnv);
		if (!executable) {
			return { message: localize('paradis.ptyDaemon.executableMissing', "Path to shell executable \"{0}\" does not exist", slc.executable) };
		}
		// 常駐に $PATH を探させない。**解決し切って渡す**のがこちら側の役目。
		slc.executable = executable;
		return undefined;
	}

	shutdown(immediate: boolean): void {
		if (this.handle === undefined) {
			return;
		}
		void this.host.kill(this.handle, immediate ? 'SIGKILL' : undefined);
	}

	input(data: string): void {
		if (this.handle === undefined) {
			return;
		}
		this.childProcesses.value?.handleInput();
		void this.host.input(this.handle, data);
	}

	sendSignal(signal: string): void {
		if (this.handle !== undefined) {
			void this.host.kill(this.handle, signal);
		}
	}

	async processBinary(data: string): Promise<void> {
		if (this.handle !== undefined) {
			await this.host.input(this.handle, data);
		}
	}

	resize(cols: number, rows: number): void {
		this.cols = cols;
		this.rows = rows;
		if (this.handle !== undefined) {
			void this.host.resize(this.handle, cols, rows);
		}
	}

	clearBuffer(): void {
		// 画面の消去は表示側の仕事で、pty には関係が無い。
	}

	acknowledgeDataEvent(charCount: number): void {
		if (this.handle !== undefined) {
			void this.host.acknowledge(this.handle, charCount);
		}
	}

	async setUnicodeVersion(): Promise<void> {
		// pty には関係が無い（upstream の `TerminalProcess` も何もしない）。
	}

	async getInitialCwd(): Promise<string> {
		return this.initialCwd;
	}

	async getCwd(): Promise<string> {
		if (this.pid < 0) {
			return this.initialCwd;
		}
		return await paradisReadCwd(this.pid, this.logService) ?? this.initialCwd;
	}

	async refreshProperty<T extends ProcessPropertyType>(property: T): Promise<IProcessPropertyMap[T]> {
		switch (property) {
			case ProcessPropertyType.Cwd:
				return await this.getCwd() as IProcessPropertyMap[T];
			case ProcessPropertyType.InitialCwd:
				return this.initialCwd as IProcessPropertyMap[T];
			case ProcessPropertyType.Title:
				return this.title as IProcessPropertyMap[T];
			case ProcessPropertyType.HasChildProcesses:
				return (this.childProcesses.value?.hasChildProcesses ?? false) as IProcessPropertyMap[T];
			default:
				throw new Error(`unsupported property: ${property}`);
		}
	}

	async updateProperty(): Promise<void> {
		// 書き込まれる種類（固定サイズなど）はこちら側の状態で、常駐は関知しない。
	}

	/**
	 * 抱える器（`PersistentTerminalProcess`）が、`ITerminalChildProcess` に加えて欲しがるもの。
	 *
	 * どれも「pty を持っている側が知っていること」で、常駐版では `currentTitle` だけが常駐から
	 * 文字列で届き、残りはこちら側で作れる。
	 */
	get currentTitle(): string {
		return this.title;
	}

	get shellType(): TerminalShellType | undefined {
		// シェルの種類はシェル統合が名乗ってきて初めて分かるもので、上の層が持つ。
		return undefined;
	}

	get hasChildProcesses(): boolean {
		return this.childProcesses.value?.hasChildProcesses ?? false;
	}

	clearUnacknowledgedChars(): void {
		// 数え直しは常駐側で起きる。**繋ぎ直した時点で向こうが 0 にする**ので、こちらから
		// 言うことは無い（`ParadisPtyHolder.attach`）。
	}

	getWindowsPty(): IProcessReadyWindowsPty | undefined {
		// この常駐は Windows では動かない。動かす日には、pty を持っている常駐側から
		// 受け取る形になる（こちらからは見えない）。
		return undefined;
	}

	/** 常駐に預けておくもの。中身は常駐から見ればただの文字列（引き取りで読む）。 */
	async paradisSetMetadata(metadata: string): Promise<void> {
		if (this.handle !== undefined) {
			await this.host.setMetadata(this.handle, metadata);
		}
	}

	override dispose(): void {
		// **常駐へは何も言わない。** ここが畳まれるのはウィンドウが閉じるときで、
		// pty を道連れにしてよい理由が無い（それを避けるために常駐がある）。
		super.dispose();
	}
}

/** `IProcessEnvironment` は undefined を含み得る。常駐へ渡す面は文字列だけにしてある。 */
function paradisPlainEnv(env: IProcessEnvironment): { [key: string]: string } {
	const plain: { [key: string]: string } = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === 'string') {
			plain[key] = value;
		}
	}
	return plain;
}

async function paradisCopyInjectionFile(source: string, dest: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(dest), { recursive: true });
	await fs.promises.copyFile(source, dest);
}
