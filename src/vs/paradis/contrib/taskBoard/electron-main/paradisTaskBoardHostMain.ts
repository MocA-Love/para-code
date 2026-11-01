/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as electron from 'electron';
import { promises as fs } from 'fs';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { findFreePort } from '../../../../base/node/ports.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { PARADIS_TASK_BOARD_BRIDGE_DISCOVERY_FILE } from '../common/paradisTaskBoardBridge.js';
import { IParadisTaskBoardHost, PARADIS_TASK_BOARD_EMBEDDED_PORT, PARADIS_TASK_BOARD_HOST_CHANNEL, ParadisTaskBoardOpenResult, ParadisTaskBoardServerMessage } from '../common/paradisTaskBoardHost.js';

/** サーバーが起動の合図を返すまで待つ時間（GitHub の認証と台帳の読み込みが先に走る）。 */
const READY_TIMEOUT_MS = 60_000;
/** 止めるときに SIGTERM の後で待つ時間（台帳を書き終えるまで）。過ぎたら SIGKILL。 */
const STOP_GRACE_MS = 5_000;

interface IRunningBoard {
	readonly child: ChildProcess;
	readonly token: string;
	readonly port: number;
	/** 接続口へ送る、起動ごとの鍵（paradisTaskBoardRelay.ts の G1）。子へは ipc で渡し、開いた窓へは open() で返す。 */
	readonly boardKey: string;
}

/** 子へ渡さない環境変数（Electron の Node として動かすための指定や、Para Code の画面の中だけの値）。 */
function boardEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		// NODE_OPTIONS: ログインシェルの --require 等が、Electron の Node として動く子にも効いてしまう
		if (value !== undefined && !/^(ELECTRON_|VSCODE_|PARA_CODE_TERMINAL_|ZDOTDIR$|NODE_OPTIONS$)/.test(key)) {
			env[key] = value;
		}
	}
	env.ELECTRON_RUN_AS_NODE = '1';
	// Windows がコマンドを作業フォルダから先に探さないように（ボードが起こす git・gh・工程のコマンドにも引き継がれる）
	env.NoDefaultCurrentDirectoryInExePath = '1';
	return env;
}

class ParadisTaskBoardHost extends Disposable implements IParadisTaskBoardHost {

	private running: IRunningBoard | undefined;
	private starting: Promise<ParadisTaskBoardOpenResult> | undefined;
	/** 起動中（合図を待っている）の子。止める操作と終了処理は、これも止める。 */
	private startingChild: ChildProcess | undefined;
	private window: electron.BrowserWindow | undefined;
	private readonly shellEnv: ParadisCachedShellEnv;
	private quitting = false;

	constructor(
		configurationService: IConfigurationService,
		private readonly environmentMainService: IEnvironmentMainService,
		lifecycleMainService: ILifecycleMainService,
		private readonly logService: ILogService,
	) {
		super();
		this.shellEnv = new ParadisCachedShellEnv(logService, 'ParadisTaskBoardHost', createParadisShellEnvResolver(logService, configurationService, environmentMainService.args));
		this._register(lifecycleMainService.onWillShutdown(event => {
			this.quitting = true;
			event.join('paradisTaskBoardHost', this.stop());
		}));
	}

	/** 同梱のボードの場所。ソースから動かしているときは `.build/paradis/taskboard`（build/paradis/taskboard/buildTaskBoard.ts の出力）。 */
	private boardRoot(): string {
		const appRoot = this.environmentMainService.appRoot;
		return this.environmentMainService.isBuilt
			? join(appRoot, 'resources', 'paradis', 'taskboard')
			: join(appRoot, '.build', 'paradis', 'taskboard');
	}

	async open(repoPath: string): Promise<ParadisTaskBoardOpenResult> {
		if (this.quitting) {
			return { ok: false, reason: 'start-failed', message: 'Para Code is quitting' };
		}
		if (!this.running) {
			this.starting ??= this.start(repoPath).finally(() => this.starting = undefined);
			const result = await this.starting;
			if (!result.ok) {
				return result;
			}
		}
		const running = this.running;
		if (!running || this.quitting) {
			return { ok: false, reason: 'start-failed' };
		}
		this.showWindow(running);
		// 既に動いているボードを開き直したときも、同じ pid と鍵を返す（窓が shared process へ登録し直す）
		return running.child.pid !== undefined ? { ok: true, board: { pid: running.child.pid, key: running.boardKey } } : { ok: true };
	}

	private async start(repoPath: string): Promise<ParadisTaskBoardOpenResult> {
		const root = this.boardRoot();
		const entry = join(root, 'server', 'main.mjs');
		if (!(await fs.access(entry).then(() => true, () => false))) {
			return { ok: false, reason: 'not-bundled', message: root };
		}
		const port = await findFreePort(PARADIS_TASK_BOARD_EMBEDDED_PORT, 20, 3000);
		if (!port) {
			return { ok: false, reason: 'start-failed', message: 'no free port' };
		}
		const token = randomBytes(24).toString('base64url');
		const boardKey = randomBytes(32).toString('base64url');
		const bridgeFile = join(this.environmentMainService.userDataPath, PARADIS_TASK_BOARD_BRIDGE_DISCOVERY_FILE);
		const env = boardEnvironment(await this.shellEnv.getEnv());
		const child = spawn(process.execPath, [entry, '--prod', '--embedded', '--agents', 'para-code', '--repo', repoPath, '--port', String(port), '--bridge', bridgeFile], {
			// 作業フォルダはリポジトリにしない。Windows は名前だけで起動したコマンドを作業フォルダから先に探すので、
			// リポジトリに置かれた git.exe などが動いてしまう（ボードの側でも、Windows では絶対パスで起動している）
			cwd: this.environmentMainService.userDataPath,
			env,
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			windowsHide: true,
		});
		// 子の出力は鍵を含まない（--embedded は鍵付きの URL を出さない）。行ごとにログへ（チャンクの境目で行を割らない）
		const forward = (stream: NodeJS.ReadableStream | null, warn: boolean) => {
			let rest = '';
			stream?.on('data', (chunk: Buffer) => {
				const lines = (rest + chunk.toString('utf8')).split('\n');
				rest = lines.pop() ?? '';
				for (const line of lines.filter(Boolean)) {
					if (warn) {
						this.logService.warn(`[ParadisTaskBoardHost] ${line}`);
					} else {
						this.logService.info(`[ParadisTaskBoardHost] ${line}`);
					}
				}
			});
		};
		forward(child.stdout, false);
		forward(child.stderr, true);
		this.startingChild = child;
		let readyPort = port;
		const result = await new Promise<ParadisTaskBoardOpenResult>(resolve => {
			const timer = setTimeout(() => finish({ ok: false, reason: 'start-failed', message: 'the task board did not start in time' }), READY_TIMEOUT_MS);
			const onMessage = (message: ParadisTaskBoardServerMessage) => {
				if (message?.type === 'ready') {
					readyPort = message.port;
					finish({ ok: true });
				} else if (message?.type === 'failed') {
					finish({ ok: false, reason: message.reason === 'busy' ? 'repo-busy' : 'start-failed', message: message.message });
				}
			};
			const onExit = (code: number | null) => finish({ ok: false, reason: 'start-failed', message: `the task board exited (${code})` });
			// 起動できなかった（フォルダが消えた等）ときは exit が来ず error だけが来る
			const onError = (error: Error) => finish({ ok: false, reason: 'start-failed', message: error.message });
			const finish = (value: ParadisTaskBoardOpenResult) => {
				clearTimeout(timer);
				child.off('message', onMessage);
				child.off('exit', onExit);
				child.off('error', onError);
				resolve(value);
			};
			child.on('message', onMessage);
			child.once('exit', onExit);
			child.on('error', onError);
			child.send({ type: 'init', token, boardKey }, error => error && onError(error));
		});
		// 起動の後も、子の error（IPC の切断の後の送信など）で main が落ちないようにする
		child.on('error', error => this.logService.warn(`[ParadisTaskBoardHost] ${error.message}`));
		if (this.startingChild === child) {
			this.startingChild = undefined;
		}
		if (!result.ok || this.quitting) {
			await this.stopChild(child);
			return result.ok ? { ok: false, reason: 'start-failed', message: 'Para Code is quitting' } : result;
		}
		const running: IRunningBoard = { child, token, port: readyPort, boardKey };
		this.running = running;
		child.once('exit', code => {
			if (this.running === running) {
				this.running = undefined;
				this.window?.close();
				if (!this.quitting) {
					this.logService.warn(`[ParadisTaskBoardHost] the task board stopped (${code})`);
				}
			}
		});
		return result;
	}

	private showWindow(running: IRunningBoard): void {
		const existing = this.window;
		if (existing && !existing.isDestroyed()) {
			if (existing.isMinimized()) {
				existing.restore();
			}
			existing.show();
			existing.focus();
			return;
		}
		const origin = `http://127.0.0.1:${running.port}`;
		const partition = 'persist:paradis-taskboard';
		const boardSession = electron.session.fromPartition(partition);
		// ボードは通知・カメラ・クリップボードなどの権限を使わない。すべて断る
		boardSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
		boardSession.setPermissionCheckHandler(() => false);
		const window = new electron.BrowserWindow({
			autoHideMenuBar: true,
			width: 1440,
			height: 900,
			minWidth: 360,
			minHeight: 480,
			// allow-any-unicode-next-line
			title: localize('paradis.taskBoard.windowTitle', "タスクボード"),
			show: false,
			backgroundColor: '#0d1117',
			webPreferences: {
				partition,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				webviewTag: false,
				spellcheck: false,
			},
		});
		this.window = window;
		if (!isMacintosh) {
			// Windows・Linux では Para Code のメニューが空のまま出るので消す
			window.removeMenu();
		}
		window.once('ready-to-show', () => window.show());
		window.on('closed', () => {
			if (this.window === window) {
				this.window = undefined;
			}
		});
		const contents = window.webContents;
		this.guardContents(contents, origin, partition);
		// Para Code の画面ではないウィンドウでは、編集のメニューの一部が届かない。よく使うキーをここで渡す
		contents.on('before-input-event', (event, input) => {
			const mod = isMacintosh ? input.meta : input.control;
			if (input.type !== 'keyDown' || !mod || input.alt) {
				return;
			}
			const key = input.key.toLowerCase();
			if (key === 'z') {
				event.preventDefault();
				if (input.shift) {
					contents.redo();
				} else {
					contents.undo();
				}
			} else if (key === 'a' && !input.shift) {
				event.preventDefault();
				contents.selectAll();
			} else if (key === 'w' && !input.shift) {
				event.preventDefault();
				window.close();
			} else if (key === 'r' && !input.shift) {
				event.preventDefault();
				contents.reload();
			}
		});
		void window.loadURL(`${origin}/?token=${encodeURIComponent(running.token)}`);
	}

	/**
	 * ボードの窓の決まり。アプリ全体の window.open の処理（about:blank を補助ウィンドウとして開き、ほかの URL は
	 * scheme を問わず OS に渡す）を引き継がないよう、ここで上書きする。自分のサーバーのページは同じ設定の窓で開き
	 * （成果物を別の窓で見る等。鍵付きの URL を OS のブラウザへ出さない）、https: だけを OS のブラウザへ渡し、ほかは断る。
	 */
	private guardContents(contents: electron.WebContents, origin: string, partition: string): void {
		const own = (url: string) => url.startsWith(`${origin}/`);
		contents.on('will-navigate', (event, url) => {
			if (!own(url)) {
				event.preventDefault();
			}
		});
		contents.setWindowOpenHandler(({ url }) => {
			if (own(url)) {
				return {
					action: 'allow',
					overrideBrowserWindowOptions: {
						width: 1200,
						height: 860,
						webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
					},
				};
			}
			if (/^https:\/\//i.test(url)) {
				void electron.shell.openExternal(url);
			}
			return { action: 'deny' };
		});
		contents.on('did-create-window', child => this.guardContents(child.webContents, origin, partition));
	}

	async stop(): Promise<void> {
		const running = this.running;
		this.running = undefined;
		const starting = this.startingChild;
		this.startingChild = undefined;
		if (this.window && !this.window.isDestroyed()) {
			this.window.close();
		}
		await Promise.all([running?.child, starting].filter((child): child is ChildProcess => child !== undefined).map(child => this.stopChild(child)));
	}

	/**
	 * 子を止める。IPC を切ると子は自分で台帳を書き終えて終わる（どの OS でも同じ経路。Windows の SIGTERM はその場で
	 * 強制終了になり、台帳の保存や印の片付けが走らない）。STOP_GRACE_MS 過ぎても残っていれば強制終了する。
	 */
	private async stopChild(child: ChildProcess): Promise<void> {
		if (child.exitCode !== null || child.signalCode !== null) {
			return;
		}
		await new Promise<void>(resolve => {
			const timer = setTimeout(() => {
				child.kill('SIGKILL');
				resolve();
			}, STOP_GRACE_MS);
			child.once('exit', () => {
				clearTimeout(timer);
				resolve();
			});
			if (child.connected) {
				child.disconnect();
			} else {
				child.kill('SIGTERM');
			}
		});
	}
}

interface IParadisTaskBoardHostChannelHost {
	registerChannel(channelName: string, channel: IServerChannel<string>): void;
}

/** app.ts から 1 行で登録する。 */
export function paradisRegisterTaskBoardHost(channelHost: IParadisTaskBoardHostChannelHost, configurationService: IConfigurationService, environmentMainService: IEnvironmentMainService, lifecycleMainService: ILifecycleMainService, logService: ILogService): IDisposable {
	const store = new DisposableStore();
	const host = store.add(new ParadisTaskBoardHost(configurationService, environmentMainService, lifecycleMainService, logService));
	// 画面から呼べるのは open と stop だけにする（ProxyChannel はクラスのほかのメソッドも呼べてしまう）
	const surface: IParadisTaskBoardHost = {
		open: repoPath => typeof repoPath === 'string' && repoPath.length > 0 ? host.open(repoPath) : Promise.resolve({ ok: false, reason: 'start-failed', message: 'invalid repository path' }),
		stop: () => host.stop(),
	};
	channelHost.registerChannel(PARADIS_TASK_BOARD_HOST_CHANNEL, ProxyChannel.fromService(surface, store));
	return store;
}
