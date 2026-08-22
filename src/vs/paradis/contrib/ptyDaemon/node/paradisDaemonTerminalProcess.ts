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
import { Emitter, Event } from '../../../../base/common/event.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isNumber } from '../../../../base/common/types.js';
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
import { IParadisPtyAttachment, IParadisPtyHost } from '../common/paradisPtyProtocol.js';
import { paradisEncodeTerminalMetadata } from '../common/paradisTerminalMetadata.js';
import { ParadisPtyDispatch } from './paradisPtyDispatch.js';
import { paradisShellTypeFromTitle } from './paradisShellType.js';

/** ターミナルの持ち主。常駐へ預けて、引き取るときに読み戻す。 */
export interface IParadisTerminalOrigin {
	/**
	 * こちら側での番号。
	 *
	 * **配置を預けるのに要る。** 配置に入っているのは番号だが、番号は起動のたびに 1 から
	 * 振り直されるので、常駐へは handle に置き換えて預ける。その対応表を作るのがここ。
	 * 覚えないと預ける配置が空になり、**次の起動で誰も繋ぎに来ない**。
	 */
	readonly id: number;
	readonly workspaceId: string;
	readonly workspaceName: string;
	readonly shouldPersist: boolean;
}
import { IParadisTerminalProcessLike } from '../common/paradisTerminalProcessLike.js';
import { IParadisAdoptTarget, paradisForgetHandle, paradisRememberHandle } from './paradisTerminalProcessFactory.js';
import { paradisReadCwd, paradisStatKind } from './paradisPtyIntrospection.js';

/**
 * 端末の種類（TERM）。
 *
 * 非 Windows で `xterm-256color` を名乗るのは upstream と同じ。渡さないと node-pty の既定
 * `xterm` になり、Linux の既定 `~/.bashrc` の色付きプロンプトが黙って落ちる。
 */
const PARADIS_TERM_NAME = 'xterm-256color';

/** `shutdown(false)` のあと、終わったと言い切るまで待つ時間。upstream の強制 kill と同じ 5 秒。 */
const GRACEFUL_EXIT_TIMEOUT = 5_000;

/** `shutdown(true)` のあと。すぐ死ぬはずなので短い。 */
const IMMEDIATE_EXIT_TIMEOUT = 1_000;

/** こぼれたことの断り。**出力そのものと見分けが付く形**にする。 */
function paradisDroppedNotice(): string {
	return `\r\n\x1b[2m[${localize('paradis.ptyDaemon.droppedOutput', "earlier output was discarded while this terminal ran unattended")}]\x1b[0m\r\n`;
}

export class ParadisDaemonTerminalProcess extends Disposable implements IParadisTerminalProcessLike {

	id = 0;
	shouldPersist = false;

	private handle: number | undefined;
	private pid = -1;
	private initialCwd: string;

	/** いまの監視。畳むのは {@link wiring} の仕事で、ここは参照を持つだけ。 */
	private childProcesses: { value: ChildProcessMonitor | undefined } = { value: undefined };

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

	/** 終わったと言い切るまでの保険（{@link shutdown}）。 */
	private readonly forceExit = this._register(new MutableDisposable());
	private exitFired = false;
	/** pty が本当に終わったか。**閉じただけとは区別する**（{@link dispose}）。 */
	private exited = false;

	private title = '';
	private reportedTitle: string | undefined;

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
		/**
		 * このターミナルが誰のものか。**常駐へ預けるのはこれ。**
		 *
		 * 預けないと、引き取ったときに所属が空になる。所属が空だと、どのウィンドウの配置にも
		 * 載らない（配置は workspaceId で引く）ので、**プロセスは生きているのに画面に出てくる
		 * 経路そのものが無い**という形になる。
		 */
		private readonly origin?: IParadisTerminalOrigin,
		/**
		 * 常駐との繋がりの生死。切れたら、開いている端末は終わったものとして畳む。
		 *
		 * 省略できるのは、テストや常駐が無い経路で邪魔にならないようにするため。
		 */
		private readonly hostLifetime?: { onDidDispose: Event<void> },
		/** 常駐から流れてくるものを配る人。省略時はこの端末だけの使い捨てを作る。 */
		dispatch?: ParadisPtyDispatch,
		/** この pty ホストの名札。常駐が「誰が見ているか」を持つのに使う。 */
		private readonly viewer: string = '',
		/**
		 * すでに常駐が抱えているものを引き取る場合の相手。
		 *
		 * これが在るときは**起こさない**。引き取りは「走っているものに繋ぎ直す」ことなので、
		 * ここで新しく起こしてしまうと、残っていたプロセスは行方不明のまま二重に増える。
		 */
		private readonly adoptTarget?: IParadisAdoptTarget,
	) {
		super();
		this.initialCwd = cwd;
		this.dispatch = dispatch ?? this._register(new ParadisPtyDispatch(host));
	}

	private readonly dispatch: ParadisPtyDispatch;

	async start(): Promise<ITerminalLaunchError | ITerminalLaunchResult | undefined> {
		if (this.adoptTarget) {
			// 走っているものに繋ぎ直すだけ。起動先の検査もシェル統合の注入もしない
			// (どちらも起こすときの話で、すでに起きているものには当てはまらない)。
			this.adopt(this.adoptTarget.handle, this.adoptTarget.pid, this.adoptTarget.title);
			this.emitAttachment(await this.host.attach(this.adoptTarget.handle, this.viewer));
			if (this.adoptTarget.exited) {
				// **もう終わっている。** イベントを待っても来ないので、ここで言う。画面には
				// 走り切った結果が出ているので、あとは終わったことが伝われば読める。
				this.exited = true;
				this.fireExitOnce(this.adoptTarget.exited.code);
			}
			return undefined;
		}

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
		let summary;
		try {
			summary = await this.host.spawn({
				file: this.shellLaunchConfig.executable!,
				args,
				env: paradisPlainEnv(env),
				cwd: this.initialCwd,
				cols: this.cols,
				rows: this.rows,
				term: PARADIS_TERM_NAME,
				metadata: this.describeSelf(),
			});
		} catch (error) {
			return { message: localize('paradis.ptyDaemon.launchFailed', "The terminal could not be started ({0})", String(error)) };
		}

		try {
			this.adopt(summary.handle, summary.pid, summary.title);
			// **戻り値を捨ててはいけない。** 常駐は繋がるまで出力を流さないので、起こしてから
			// 繋ぐまでの間に出たものはここにしか無い。捨てると、消えるのは決まって
			// 「シェルの起動直後」＝プロンプトと初期エスケープ列になり、症状は
			// 「たまに1行目が出ない」という辿れない形になる。
			this.emitAttachment(await this.host.attach(summary.handle, this.viewer));
			if (this._store.isDisposed || this.exitFired) {
				// 起こしている間に閉じられていた。抱えたまま放置すると、誰も見ていない端末が
				// 常駐に残り、次の起動で身に覚えのないタブとして現れる。
				await this.host.release(summary.handle).catch(() => { });
				return undefined;
			}
		} catch (error) {
			// 起こしはしたが繋げなかった。**常駐に置き去りにしない。** 残すと誰も見ていない
			// holder が一覧にだけ残り、次の引き取りで身に覚えのないターミナルとして現れる。
			this.logService.error('[ParadisPtyDaemon] could not attach to the terminal just started; releasing it', error);
			await this.host.release(summary.handle).catch(() => { });
			return { message: localize('paradis.ptyDaemon.attachFailed', "The terminal started but could not be connected to ({0})", String(error)) };
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
		if (this.origin) {
			// 起こしたときも引き取ったときも、同じここを通る。
			paradisRememberHandle(this.origin.id, handle);
		}

		const wiring = new DisposableStore();
		this.wiring.value = wiring;
		// 本体も購読も同じところに入れる。別々にすると、片方だけ差し替えたときに
		// 畳まれた相手への購読が残る。
		const monitor = wiring.add(new ChildProcessMonitor(pid, this.logService));
		this.childProcesses.value = monitor;
		wiring.add(monitor.onDidChangeHasChildProcesses(value => this._onDidChangeProperty.fire({ type: ProcessPropertyType.HasChildProcesses, value })));
		// **配る側は1つ。** 端末ごとに常駐を購読すると、全端末の全出力が本数ぶんソケットを通る。
		const stream = wiring.add(this.dispatch.listen(handle));
		wiring.add(stream.onData(data => {
			this._onProcessData.fire(data);
			this.childProcesses.value?.handleOutput();
		}));
		wiring.add(stream.onTitle(title => this.reportTitle(title)));
		// **常駐が落ちたら、終わったことにする。** 繋がりが切れると出力も終了も二度と来ない。
		// 黙って無反応のままにすると、器が畳まれずタブも閉じられなくなる。プロセス自体は
		// 常駐と一緒に落ちているので、終わったと伝えるのが実態に合う。
		if (this.hostLifetime) {
			wiring.add(this.hostLifetime.onDidDispose(() => this.fireExitOnce(undefined)));
		}
		wiring.add(stream.onExit(code => {
			this.exited = true;
			this.fireExitOnce(code);
		}));

		this._onProcessReady.fire({ pid, cwd: this.initialCwd, windowsPty: undefined });
		// **引き取りでは常駐側が題名の変化を出さない**（向こうは既に同じ値を覚えているため）。
		// ここで出しておかないと、更新をまたいだ直後だけタブ名が空になる。
		this.reportTitle(title);
	}

	/**
	 * 繋いだ時点で常駐が持っていたものを流す。
	 *
	 * こぼれていた断りもここで出す。**歯抜けの画面を黙って見せない**ため。
	 */
	private emitAttachment(attachment: IParadisPtyAttachment): void {
		if (attachment.dropped) {
			this._onProcessData.fire(paradisDroppedNotice());
		}
		for (const frame of attachment.frames) {
			if (frame.data.length > 0) {
				this._onProcessData.fire(frame.data);
			}
		}
	}

	/**
	 * 題名と、そこから読めるシェルの種類を伝える。
	 *
	 * 種類も一緒に出すのは upstream と同じ。片方だけだと、タブ名の `${sequence}` やシェル統合の
	 * 質が常駐経由のときだけ変わる。
	 */
	private reportTitle(title: string): void {
		this.title = title;
		if (title === this.reportedTitle) {
			// 起こした直後は、こちらと常駐の両方から同じ題名が来る（引き取りでは常駐から来ない
			// ので、こちらから出す必要がある）。同じ値なら黙る。
			return;
		}
		this.reportedTitle = title;
		this._onDidChangeProperty.fire({ type: ProcessPropertyType.Title, value: title });
		this._onDidChangeProperty.fire({ type: ProcessPropertyType.ShellType, value: paradisShellTypeFromTitle(title) });
	}

	/** 終わったと言うのは一度だけ。保険と本物の両方から来る。 */
	private fireExitOnce(code: number | undefined): void {
		if (this.exitFired) {
			return;
		}
		this.exitFired = true;
		this.forceExit.clear();
		this._onProcessExit.fire(code);
		// **自分で畳む。** 抱えている器はこれを畳んでくれない（upstream の `TerminalProcess` も
		// 終了を告げた直後に自分を畳んでいる）。畳まないと常駐へ何も伝わらず、終わった端末が
		// 抱えられたまま残り、次の起動でタブとして戻ってくる。
		//
		// **溜まっていた出力より先に畳んでも取りこぼさない。** 順序を確かめてある:
		//   1. ここの `_onProcessExit.fire()` が、張られた順に購読を呼ぶ
		//   2. 器は自分のコンストラクタで購読を張っており（`PtyService` が器を作った後に張る
		//      自分の購読より先）、そこで溜めを止める
		//   3. 溜めを止めると、その場で溜まっていたぶんが掃き出される
		//      （`TerminalDataBufferer` の dispose が `flushBuffer` を呼ぶ）
		//   4. 全部の購読が終わってから、この行に戻ってくる
		// 引き取り経路（控えを流した直後に終了を告げる）でも同じで、画面は必ず先に出る。
		this.dispose();
	}

	private toArgs(args: string | string[] | undefined): string[] {
		if (args === undefined) {
			return [];
		}
		if (typeof args === 'string') {
			// 文字列の `args` は「エスケープ済みの CommandLine で Windows 専用」と upstream が
			// 明記している形。**配列に包むと意味が静かに変わる**（1個の argv 要素になる）ので
			// 包まない。この常駐は Windows では動かないため、ここへは来ない想定。
			throw new Error('a pre-escaped command line is only meaningful on Windows, where this daemon does not run');
		}
		return args;
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

	/**
	 * 常駐へ言うだけで返事を待たない呼び出しを、まとめて受ける。
	 *
	 * **`void` で投げっぱなしにしない。** 常駐が落ちた・繋がりが切れた・すでに終わった相手に
	 * resize した、といった場合に拒否が返るが、投げっぱなしだと**打鍵1回ごとに未処理の拒否**が
	 * 積み上がる。できることは無いので、記録して進む。
	 */
	private tell(what: string, work: Promise<unknown>): void {
		work.catch(error => this.logService.trace(`[ParadisPtyDaemon] ${what} did not reach the daemon`, error));
	}

	shutdown(immediate: boolean): void {
		// **終わらせろと言われたことを覚える。** 覚えないと、握り潰すプロセスで時間切れ経由の
		// 終了になったときに「見るのをやめただけ」として常駐に残り、閉じたはずの端末が次の
		// 起動で復活する。
		this.exited = true;
		if (this.handle === undefined) {
			// まだ常駐に繋がっていない（起こしている最中に閉じられた）。**それでも終わったとは
			// 言う**（upstream の `_kill` も pty の有無に関わらず必ず言う）。言わないと器が
			// 畳まれずタブが閉じられないうえ、後から起動が完走したぶんが常駐に孤児として残る。
			this.fireExitOnce(undefined);
			return;
		}
		this.tell('shutdown', this.host.kill(this.handle, immediate ? 'SIGKILL' : undefined));
		// **終わったことを必ず伝える。** SIGHUP を握り潰すプロセスだと exit が来ないことがあり、
		// 来ないと器が畳まれず、タブが閉じないまま台帳に残り続ける。upstream も、pty が本当に
		// 死んだかに関わらず最後は必ず exit を出す。
		this.forceExit.value = disposableTimeout(() => this.fireExitOnce(undefined), immediate ? IMMEDIATE_EXIT_TIMEOUT : GRACEFUL_EXIT_TIMEOUT);
	}

	input(data: string): void {
		if (this.handle === undefined) {
			return;
		}
		this.childProcesses.value?.handleInput();
		this.tell('input', this.host.input(this.handle, data));
	}

	sendSignal(signal: string): void {
		if (this.handle !== undefined) {
			this.tell('signal', this.host.kill(this.handle, signal));
		}
	}

	async processBinary(data: string): Promise<void> {
		if (this.handle !== undefined) {
			// バイト列として書かせる。UTF-8 として書かれると 0x80-0xFF が変わってしまう。
			await this.host.input(this.handle, data, true);
		}
	}

	resize(cols: number, rows: number): void {
		if (!isNumber(cols) || !isNumber(rows) || isNaN(cols) || isNaN(rows)) {
			return;
		}
		// 0 は「まだ大きさが決まっていない」の意味で来る。そのまま渡すと pty が困る。
		this.cols = Math.max(cols, 1);
		this.rows = Math.max(rows, 1);
		if (this.handle !== undefined) {
			this.tell('resize', this.host.resize(this.handle, this.cols, this.rows));
		}
	}

	clearBuffer(): void {
		// pty には関係が無いが、**控えには効かせる**。効かせないと、消したはずの出力が
		// 繋ぎ直したときに戻ってくる。
		if (this.handle !== undefined) {
			this.tell('clearBuffer', this.host.clearScrollback(this.handle));
		}
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
				// upstream も既定は種類を返す。投げると、知らない種類を聞かれただけで
				// 呼び出し側が壊れる。
				return this.shellType as IProcessPropertyMap[T];
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
		return paradisShellTypeFromTitle(this.title);
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

	/**
	 * 常駐へ預ける、引き取りに要るもの。
	 *
	 * 起動時の材料（シェル設定と環境）まで入れるのは、引き取った器を後で「保存して復元」する
	 * ときに要るため。無くても引き取りはできるが、そのときは材料が空の器になる。
	 */
	/**
	 * 預かりものは**起こしたときの1回きり**で、以後は更新しない。
	 *
	 * したがって更新をまたいで引き取ると、**タブのリネームやアイコンの変更は起動時の値に戻る**。
	 * 追従させるには、題名やアイコンが変わるたびに常駐へ書き戻す口を上の層から引く必要があり、
	 * 触る面が増える。**走っているプロセスを失わないことに比べれば、名前が戻るのは軽い**ので、
	 * いまは追従させない側を選んでいる。
	 *
	 * 追従させないと決めた以上、書き戻す口は置かない（置くと、次に読む人が「効いているはず」と
	 * 読む）。必要になったら、ここを起点に足すこと。
	 */
	private describeSelf(): string {
		return paradisEncodeTerminalMetadata({
			workspaceId: this.origin?.workspaceId ?? '',
			workspaceName: this.origin?.workspaceName ?? '',
			shouldPersist: this.origin?.shouldPersist ?? true,
			name: this.shellLaunchConfig.name,
			launch: {
				shellLaunchConfig: this.shellLaunchConfig,
				env: this.env,
				executableEnv: this.executableEnv,
				options: this.options,
			},
		});
	}

	/**
	 * 見るのをやめる。**pty は止めない。**
	 *
	 * upstream の `ITerminalChildProcess` に `detach` は無いので、実際に通るのは {@link dispose}
	 * だけ。将来 upstream 側に口ができたときに繋げられるよう、名前は合わせてある。
	 */
	async detach(): Promise<void> {
		if (this.handle !== undefined) {
			await this.host.detach(this.handle).catch(() => { });
		}
	}

	override dispose(): void {
		// **pty は道連れにしないが、見るのをやめたことは伝える。** 伝えないと、常駐側は
		// 「まだ誰かが見ている」と思って未確認の文字を数え続け、誰も受け取ったと言わないので
		// 高水位で pty が止まる。閉じている間も走り切らせるという判断が、そこで無言で覆る。
		//
		// なお、落ちた・強制終了された場合はここを通らない。そちらは常駐側が接続の切断を
		// 合図にして離す（`paradisPtyHostDaemonMain.ts`）。**片方だけでは足りない。**
		if (this.origin) {
			paradisForgetHandle(this.origin.id);
		}
		if (this.handle !== undefined) {
			// **終わったものは手放し、閉じただけなら残す。** ここを取り違えると、片方は
			// 「閉じたら殺される」（常駐にした意味が消える）、もう片方は「終わった端末が
			// 常駐に残り続け、次の起動でタブとして全部戻ってくる」になる。手放さないと
			// 抱えている本数が減らないので、常駐が畳まれる判断も効かなくなる。
			this.tell(this.exited ? 'release' : 'detach', this.exited ? this.host.release(this.handle) : this.host.detach(this.handle));
		}
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
