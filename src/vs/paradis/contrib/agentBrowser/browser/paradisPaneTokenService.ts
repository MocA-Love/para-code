/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルインスタンス毎の「ペイントークン」を管理するworkbenchサービス。
// terminalInstanceService.ts の createInstance()（全ターミナル生成経路のチョークポイント）から
// PARA-PATCH 1行で呼ばれ、PTY起動前の IShellLaunchConfig.env にトークンとポートファイルパスを注入する。
// ウィンドウリロード時の永続ターミナル再接続では、PTYと共にreviveされる
// shellIntegrationNonceから同じトークンを復元する。再接続に失敗して新しいシェルを起こし直す
// 経路でも同じトークンのenvが付くよう、再接続時も env を用意しておく。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, IDisposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { ITerminalInstance, ITerminalInstanceService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paneTokenFromShellIntegrationNonce, restoredPaneToken } from '../../mobileRelay/common/paradisTerminalPersistence.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IParadisCodexPaneRuntime, paradisCreateTerminalPaneEnvironment, PARADIS_MCP_PORT_FILE_NAME } from '../common/paradisAgentBrowser.js';
import { paradisRemoteHookPortFilePath, paradisRemoteHookSourceId } from '../common/paradisRemoteHookSource.js';
import { paradisRemoteUserHome } from '../common/paradisRemoteUserHome.js';
import { paradisListCurrentPaneTokens } from './paradisLivePaneInstances.js';
import { IParadisCodexLaunchHomeService, paradisApplyCodexLaunchHome, PARADIS_CODEX_HOME_ENV_VAR, paradisTerminalRunsOnWindowHost } from '../../codexAccounts/browser/paradisCodexLaunchHomeService.js';
import { paradisPrepareTerminalCloseCleanupEnv } from '../../terminalCloseCleanup/browser/paradisTerminalCloseCleanupEnv.js';
import { ParadisClaudeModEnvironment } from '../../claudeMod/browser/paradisClaudeModEnvironment.js';
import { paradisAddClaudePluginDir } from '../../claudeMod/common/paradisClaudeMod.js';

export const IParadisPaneTokenService = createDecorator<IParadisPaneTokenService>('paradisPaneTokenService');

/**
 * ターミナルインスタンスとペイントークンの対応を管理するサービス。
 * トークンはPTY環境変数としてエージェントCLIに継承され、shared process上のMCPサーバーが
 * バインディングレジストリと突合する際の識別子（Bearerトークン）になる。
 */
export interface IParadisPaneTokenService {
	readonly _serviceBrand: undefined;

	/** トークンの割り当て・解除が起きたときに発火する。 */
	readonly onDidChange: Event<void>;

	/** 指定インスタンスに割り当てられたトークンを返す。 */
	getTokenForInstance(instanceId: number): string | undefined;

	/** 指定トークンが割り当てられたインスタンスIDを返す。 */
	getInstanceForToken(token: string): number | undefined;

	/** UI上のactive/park状態に関係なく、disposeされていない全ペイントークンを返す。 */
	listPaneTokens(): readonly { readonly instanceId: number; readonly token: string }[];

	/**
	 * PTY起動前の {@link IShellLaunchConfig} にペイントークン等のenvを注入する。
	 * `attachPersistentProcess`（永続ターミナル再接続）の場合も、繋ぎに失敗して新しいシェルを
	 * 起こし直す経路に備えて同じトークンのenvを入れておく（繋げたときは使われない）。
	 */
	prepareShellLaunchConfig(shellLaunchConfig: IShellLaunchConfig): void;
}

export class ParadisPaneTokenService extends Disposable implements IParadisPaneTokenService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _tokenByInstanceId = new Map<number, string>();
	private readonly _instanceIdByToken = new Map<string, number>();
	private readonly _instanceListeners = this._register(new DisposableMap<number, IDisposable>());

	/**
	 * 接続先のホームディレクトリ。SSH で繋いでいるときだけ入る。
	 *
	 * ペインへ渡すパスは接続先のものでなければならない（ターミナルが動くのは接続先）。env の
	 * 組み立ては PTY 起動の直前に同期で走るので、解決を待てない。接続してすぐ一度だけ取り、
	 * ここへ控えておく。間に合わなかったターミナルは、これまでどおり手元のパスのまま動く
	 * （接続先の hook とランチャーだけが効かない）。
	 */
	private remoteHome: string | undefined;

	/**
	 * 手元のペインの Claude Code に読ませる Para Code の mod（Claude Mods）。手元で動く desktop の
	 * ウィンドウだけが持つ（SSH の接続先・Windows・web では作らない。NOTES.md「Claude Mods」）。
	 */
	private readonly claudeMod: ParadisClaudeModEnvironment | undefined;

	constructor(
		@ITerminalInstanceService terminalInstanceService: ITerminalInstanceService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IPathService pathService: IPathService,
		@IParadisCodexLaunchHomeService private readonly codexLaunchHomeService: IParadisCodexLaunchHomeService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const appRoot = (this.environmentService as IWorkbenchEnvironmentService & { readonly appRoot?: string }).appRoot;
		this.claudeMod = this.environmentService.remoteAuthority === undefined && typeof appRoot === 'string' && !isWindows
			? this._register(instantiationService.createInstance(ParadisClaudeModEnvironment, appRoot, () => pathService.userHome(), undefined))
			: undefined;

		if (this.environmentService.remoteAuthority !== undefined) {
			pathService.userHome().then(home => {
				// 接続先の環境が解決できていないと userHome() は手元のホームを返す。それを接続先の
				// ホームとして扱うと、接続先には無い場所を PATH やポートファイルとして渡すことになる
				this.remoteHome = paradisRemoteUserHome(this.environmentService.remoteAuthority, home)?.path;
			}, () => {
				// 取れなければ手元のパスのまま。接続先で hook とランチャーが効かないだけ
			});
		}

		// terminalInstanceService.createInstance() 内の PARA-PATCH 行（_onDidCreateInstance.fire より前）で
		// 本サービスが初回インスタンス化されるため、この購読は最初の fire にも間に合う。
		this._register(terminalInstanceService.onDidCreateInstance(instance => this._handleInstanceCreated(instance)));
	}

	getTokenForInstance(instanceId: number): string | undefined {
		return this._tokenByInstanceId.get(instanceId);
	}

	getInstanceForToken(token: string): number | undefined {
		return this._instanceIdByToken.get(token);
	}

	listPaneTokens(): readonly { readonly instanceId: number; readonly token: string }[] {
		return paradisListCurrentPaneTokens(this._tokenByInstanceId, this._instanceIdByToken);
	}

	prepareShellLaunchConfig(shellLaunchConfig: IShellLaunchConfig): void {
		const portFilePath = this._getPortFilePath();
		if (!portFilePath) {
			// デスクトップ以外（userDataPathが無いWeb workbench等）では本機能は無効。
			return;
		}

		const attachTarget = shellLaunchConfig.attachPersistentProcess;
		// 再接続でも env は入れておく。繋げたときはプロセスが元の env を持っているので使われないが、
		// 繋げなかったとき（アプリ終了時に一度も入力されずバッファが保存されなかったターミナル、
		// pty host に同じ id が無い等）は terminalProcessManager がこの shellLaunchConfig のまま
		// 新しいシェルを起こす。ここで入れておかないと、そのシェルだけペイントークンを持たず、
		// hook・通知・ブラウザ共有が効かない。
		// nonce とトークンは _handleInstanceCreated が登録するものと同じ決め方にする
		// （TerminalInstance は shellIntegrationNonce が無ければ attach 先の nonce を引き継ぐ）。
		const nonce = shellLaunchConfig.shellIntegrationNonce ?? attachTarget?.shellIntegrationNonce;
		if (nonce === undefined || nonce.length === 0) {
			return;
		}
		const token = attachTarget
			? restoredPaneToken(nonce, attachTarget.paradisPaneToken)
			: paneTokenFromShellIntegrationNonce(nonce);
		// CDP URLは動的ポート確定前に固定注入せず、ユーザーが指定済みならその値を保持する。
		shellLaunchConfig.env = paradisCreateTerminalPaneEnvironment(shellLaunchConfig.env, token, portFilePath, this._getCodexRuntime());
		// Codex のアカウント切替: 選んだアカウントのホームを新しく開くターミナルへ渡す。選択はウィンドウの
		// マシン（手元のウィンドウなら手元、SSH のウィンドウなら接続先）のホームを指すので、別のマシンで
		// 動くターミナルには渡さない。
		// 呼び出し側が CODEX_HOME を決めているとき（会話を、その会話のあるホームで再開する等）はそちらを使う。
		const onWindowHost = paradisTerminalRunsOnWindowHost(shellLaunchConfig.cwd, this.environmentService.remoteAuthority);
		const explicitCodexHome = shellLaunchConfig.env?.[PARADIS_CODEX_HOME_ENV_VAR];
		const codexHome = typeof explicitCodexHome === 'string' && explicitCodexHome.length > 0
			? explicitCodexHome
			: onWindowHost ? this.codexLaunchHomeService.getLaunchHome() : undefined;
		shellLaunchConfig.env = paradisApplyCodexLaunchHome(shellLaunchConfig.env, codexHome);
		// Claude Code へ Para Code の mod を読ませる（ユーザーが設定している値の後ろへつなぐ）。手元で動く
		// ペインだけ。読ませられないとき（準備中・設定でオフ・組織の方針）は何も足さず、今までどおり動く。
		const claudePluginDirectory = onWindowHost ? this.claudeMod?.pluginDirectory() : undefined;
		if (claudePluginDirectory !== undefined) {
			shellLaunchConfig.env = paradisAddClaudePluginDir(shellLaunchConfig.env, claudePluginDirectory, ':');
		}
		// 開いたときのホームを覚えるのは新しく開いたペインだけ。再接続したペインのプロセスは元の env
		// （前回起動したときの CODEX_HOME）のまま動いているので、いまの選択を記録すると食い違う。
		// 記録しないペインは、切替の通知で「切替の直前の選択で開いたもの」とみなされる
		// （paradisCodexAccounts.contribution.ts）。
		if (attachTarget === undefined && onWindowHost) {
			this.codexLaunchHomeService.recordPaneHome(token, codexHome);
		}
	}

	/**
	 * Codex のランチャー（`resources/paradis/bin/codex`）の居場所。
	 *
	 * POSIX ではランチャーを PATH の先頭に入れる。素の `codex` は起動済みの共有バックグラウンド
	 * サーバーへ相乗りし（0.157 からは無ければ起動もする）、hook と MCP がそのサーバーを最初に起こした
	 * ターミナルの env で動く。ランチャーは `--no-daemon`（古い Codex では自動起動を止める指定）を
	 * 足して本物の `codex` を動かすだけで、`--remote` は付けない（2026-10 にペイン専用 app-server と
	 * モバイルのライブ連携をやめた。`--remote` の resume・fork は権限の指定を受け付けないため）。
	 * Windows では入れない。.ps1 / .cmd / .cjs の経路は、実行ポリシーが Restricted の PowerShell や
	 * pnpm・自作のラッパーで入れた codex で起動しなくなるおそれがある（2026-09-30 のレビュー）。
	 */
	private _getCodexRuntime(): IParadisCodexPaneRuntime | undefined {
		if (this.environmentService.remoteAuthority !== undefined) {
			return this._getRemoteCodexRuntime();
		}
		const appRoot = (this.environmentService as IWorkbenchEnvironmentService & { readonly appRoot?: string }).appRoot;
		if (typeof appRoot !== 'string' || isWindows) {
			return undefined;
		}
		return { launcherDirectory: join(appRoot, 'resources', 'paradis', 'bin'), pathDelimiter: ':' };
	}

	/**
	 * 接続先で動くターミナルへ渡すランチャーの居場所（置く側は paradisRemoteAgentHooks.contribution.ts）。
	 * 手元のパスを渡すと、存在しない場所を PATH の先頭に置くことになる。接続先は SSH なので常に POSIX。
	 */
	private _getRemoteCodexRuntime(): IParadisCodexPaneRuntime | undefined {
		const paraCodeDirectory = this._getRemoteParaCodeDirectory();
		if (paraCodeDirectory === undefined) {
			return undefined;
		}
		return { launcherDirectory: `${paraCodeDirectory}/bin`, pathDelimiter: ':' };
	}

	/**
	 * 接続先の `~/.para-code`。ホームがまだ取れていなければ undefined。
	 *
	 * SSH の接続先に限る。ランチャーを置くのも実行権を付けるのも SSH 前提の経路なので、
	 * 他の種類の接続先（WSL・コンテナ）では置かれないものを指してしまう。
	 * デスクトップに限るのも同じ理由で、web workbench には置く側の contribution が無い。
	 */
	private _getRemoteParaCodeDirectory(): string | undefined {
		const userDataPath = (this.environmentService as IWorkbenchEnvironmentService & { readonly userDataPath?: string }).userDataPath;
		if (typeof userDataPath !== 'string' || userDataPath.length === 0
			|| this.environmentService.remoteAuthority?.startsWith('ssh-remote+') !== true
			|| this.remoteHome === undefined || this.remoteHome.length === 0) {
			return undefined;
		}
		return `${this.remoteHome.replace(/\/+$/, '')}/.para-code`;
	}

	private _getPortFilePath(): string | undefined {
		// 接続先で動くエージェントが読むのは接続先のポートファイル。同じ内容のものを
		// paradisRemoteAgentHooks.contribution.ts が置いている。この PC 専用の置き場を渡すので、
		// 同じ接続先へ別の PC からも繋いでいても、hook はこのペインを開いた PC へ届く
		const remoteParaCodeDirectory = this._getRemoteParaCodeDirectory();
		if (remoteParaCodeDirectory !== undefined) {
			const sourceId = paradisRemoteHookSourceId((this.environmentService as IWorkbenchEnvironmentService & { readonly machineId?: string }).machineId);
			return sourceId !== undefined
				? paradisRemoteHookPortFilePath(remoteParaCodeDirectory, sourceId)
				: `${remoteParaCodeDirectory}/${PARADIS_MCP_PORT_FILE_NAME}`;
		}
		// INativeWorkbenchEnvironmentService（electron-browser）を型importするとlayer違反になるため、
		// デスクトップでのみ存在する userDataPath をプロパティ有無で判定する。
		const userDataPath = (this.environmentService as IWorkbenchEnvironmentService & { readonly userDataPath?: string }).userDataPath;
		if (typeof userDataPath !== 'string' || userDataPath.length === 0) {
			return undefined;
		}
		return join(userDataPath, PARADIS_MCP_PORT_FILE_NAME);
	}

	private _handleInstanceCreated(instance: ITerminalInstance): void {
		const nonce = instance.shellIntegrationNonce;
		if (nonce.length === 0) {
			return;
		}
		const revivedPaneToken = instance.shellLaunchConfig.attachPersistentProcess?.paradisPaneToken;
		const token = restoredPaneToken(nonce, revivedPaneToken);
		this._registerInstance(instance, token);
	}

	private _registerInstance(instance: ITerminalInstance, token: string): void {
		this._tokenByInstanceId.set(instance.instanceId, token);
		this._instanceIdByToken.set(token, instance.instanceId);
		this._instanceListeners.set(instance.instanceId, instance.onDisposed(() => {
			this._tokenByInstanceId.delete(instance.instanceId);
			// 同じPTYをdetach/reattachして新instanceへ移した後の遅延disposeで、新対応を消さない。
			if (this._instanceIdByToken.get(token) === instance.instanceId) {
				this._instanceIdByToken.delete(token);
				this.codexLaunchHomeService.forgetPaneHome(token);
			}
			this._instanceListeners.deleteAndDispose(instance.instanceId);
			this._onDidChange.fire();
		}));
		this._onDidChange.fire();
	}
}

registerSingleton(IParadisPaneTokenService, ParadisPaneTokenService, InstantiationType.Delayed);

/**
 * terminalInstanceService.ts の PARA-PATCH 点から呼ばれる薄いヘルパー。
 * ロジック本体（トークン復元・env注入）はすべて {@link ParadisPaneTokenService} 側にある。
 * ターミナル生成を決して壊さないよう、例外はここで握りつぶす。
 */
export function paradisPrepareTerminalPaneEnv(instantiationService: IInstantiationService, shellLaunchConfig: IShellLaunchConfig): void {
	try {
		instantiationService.invokeFunction(accessor => accessor.get(IParadisPaneTokenService).prepareShellLaunchConfig(shellLaunchConfig));
	} catch {
		// env注入に失敗してもターミナル生成自体は続行させる
	}
	// 閉じたときに裏のプロセスを止めるか（W2-32）の印も、同じ生成の関門で env へ写す。
	paradisPrepareTerminalCloseCleanupEnv(instantiationService, shellLaunchConfig);
}
