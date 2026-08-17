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
// shellIntegrationNonceから同じトークンを復元する。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, IDisposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { ITerminalInstance, ITerminalInstanceService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { PARADIS_MOBILE_CODEX_DAEMON_STREAMING_KEY, PARADIS_MOBILE_ENABLED_KEY } from '../../mobileRelay/common/paradisMobileRelay.js';
import { paneTokenFromShellIntegrationNonce, restoredPaneToken } from '../../mobileRelay/common/paradisTerminalPersistence.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IParadisCodexPaneRuntime, paradisCodexPaneEndpointFilePath, paradisCodexPaneSocketPath, paradisRemoteCodexPaneSocketPath, paradisCreateTerminalPaneEnvironment, PARADIS_MCP_PORT_FILE_NAME } from '../common/paradisAgentBrowser.js';
import { paradisListCurrentPaneTokens } from './paradisLivePaneInstances.js';

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
	 * ペイン専用 Codex app-server を立てる設定になっているか。
	 * 立てないなら、その宛先を用意する側（SSH接続先へのソケット転送など）も一緒に畳む。
	 */
	isCodexPaneAppServerEnabled(): boolean;

	/**
	 * PTY起動前の {@link IShellLaunchConfig} にペイントークン等のenvを注入する。
	 * `attachPersistentProcess`（永続ターミナル再接続）の場合は元のPTY環境を保持するため
	 * envを変更せず、インスタンス生成後にrevive済みnonceから対応を復元する。
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
	 * （Codex のペイン専用サーバーだけが立たない）。
	 */
	private remoteHome: string | undefined;

	constructor(
		@ITerminalInstanceService terminalInstanceService: ITerminalInstanceService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IPathService pathService: IPathService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		if (this.environmentService.remoteAuthority !== undefined) {
			pathService.userHome().then(home => {
				this.remoteHome = home.path;
			}, () => {
				// 取れなければ手元のパスのまま。接続先で Codex のペイン専用サーバーが立たないだけ
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
		if (shellLaunchConfig.attachPersistentProcess) {
			// 再接続: プロセスは生きていて元のenvを保持しているため注入しない。
			return;
		}

		const portFilePath = this._getPortFilePath();
		if (!portFilePath) {
			// デスクトップ以外（userDataPathが無いWeb workbench等）では本機能は無効。
			return;
		}

		const nonce = shellLaunchConfig.shellIntegrationNonce;
		if (nonce === undefined || nonce.length === 0) {
			return;
		}
		const token = paneTokenFromShellIntegrationNonce(nonce);
		// CDP URLは動的ポート確定前に固定注入せず、ユーザーが指定済みならその値を保持する。
		shellLaunchConfig.env = paradisCreateTerminalPaneEnvironment(shellLaunchConfig.env, token, portFilePath, this._getCodexRuntime(token));
	}

	/**
	 * ペイン専用 Codex app-server を立てる設定になっているか。
	 *
	 * この app-server は「MCPサーバーにペインのenvを継がせる」ためだけに入れたもので、それは
	 * `--remote` を使わない素の Codex なら元から成り立つ（MCPを起こすのはCodex自身のプロセスで、
	 * そのenvはペインのシェルから継いでいる）。一方で代償は大きく、ペインごとにapp-serverが1本
	 * 立ち、その配下でMCPが丸ごと起動し直される。Codexを開くたびに毎回起きる。
	 *
	 * 立てる価値があるのはモバイルのライブ連携（生成中テキスト・動的モデル一覧・次ターン設定）を
	 * 使うときだけ。読み手（paradisMobileRelay.contribution.ts の syncAgentLiveOptions）と
	 * 同じ条件で判定する。ここだけ緩いと、モバイルを切っている人が誰も繋がないapp-serverの
	 * 代金だけ払うことになる。
	 */
	isCodexPaneAppServerEnabled(): boolean {
		return this.configurationService.getValue(PARADIS_MOBILE_ENABLED_KEY) === true
			&& this.configurationService.getValue(PARADIS_MOBILE_CODEX_DAEMON_STREAMING_KEY) === true;
	}

	/**
	 * ペイン専用 Codex app-server の居場所。立てない設定なら undefined を返し、ランチャーも
	 * ソケットも env へ入れない（= ペインでは素の `codex` がそのまま動く）。
	 *
	 * env はPTY起動時に一度きり組み立てられるので、設定を変えても既に開いているターミナルの
	 * 中身は変わらない（新しく開いたターミナルから効く）。設定の説明文にも同じことを書いてある。
	 */
	private _getCodexRuntime(token: string): IParadisCodexPaneRuntime | undefined {
		if (!this.isCodexPaneAppServerEnabled()) {
			return undefined;
		}
		if (this.environmentService.remoteAuthority !== undefined) {
			return this._getRemoteCodexRuntime(token);
		}
		const desktopEnvironment = this.environmentService as IWorkbenchEnvironmentService & {
			readonly appRoot?: string;
			readonly userDataPath?: string;
			readonly execPath?: string;
		};
		const { appRoot, userDataPath, execPath } = desktopEnvironment;
		if (typeof appRoot !== 'string' || typeof userDataPath !== 'string') {
			return undefined;
		}
		const launcherDirectory = join(appRoot, 'resources', 'paradis', 'bin');
		if (isWindows) {
			// WindowsのNode(libuv)はAF_UNIXを扱えないため、ランチャーがloopback ws + capability
			// tokenでapp-serverを立て、実ポートをendpointファイルへ書く（設計はNOTES.md参照）。
			// ランチャーJSはPara Code自身のexeを ELECTRON_RUN_AS_NODE=1 で実行する。
			const endpointFilePath = paradisCodexPaneEndpointFilePath(userDataPath, token);
			if (endpointFilePath === undefined || typeof execPath !== 'string' || execPath.length === 0) {
				return undefined;
			}
			return { launcherDirectory, endpointFilePath, nodeExecutablePath: execPath, pathDelimiter: ';' };
		}
		const socketPath = paradisCodexPaneSocketPath(userDataPath, token);
		if (socketPath === undefined) {
			return undefined;
		}
		return { launcherDirectory, socketPath, pathDelimiter: ':' };
	}

	/**
	 * 接続先で動くターミナルへ渡す Codex の居場所。
	 *
	 * ランチャーとソケットは接続先に無いと意味がない（手元のパスを渡すと、存在しない場所を
	 * PATH の先頭に置き、作られもしないソケットを指すことになる）。置く側は
	 * paradisRemoteAgentHooks.contribution.ts、手元から届くようにするのはソケットの転送。
	 *
	 * 接続先は SSH なので常に POSIX として扱う（Windows のendpoint方式は使わない）。
	 */
	private _getRemoteCodexRuntime(token: string): IParadisCodexPaneRuntime | undefined {
		// 手元が Windows のときは入れない。読み手（shared process）は Windows では socket ではなく
		// endpoint ファイルを見るので、socket を渡しても原理的に繋がらないうえ、接続先の
		// ランチャーは `/…/x.sock` の形しか受け付けず毎回警告を出す
		if (isWindows) {
			return undefined;
		}
		const paraCodeDirectory = this._getRemoteParaCodeDirectory();
		if (paraCodeDirectory === undefined) {
			return undefined;
		}
		const socketPath = paradisRemoteCodexPaneSocketPath(paraCodeDirectory, token);
		if (socketPath === undefined) {
			return undefined;
		}
		return { launcherDirectory: `${paraCodeDirectory}/bin`, socketPath, pathDelimiter: ':' };
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
		// paradisRemoteAgentHooks.contribution.ts が置いている
		const remoteParaCodeDirectory = this._getRemoteParaCodeDirectory();
		if (remoteParaCodeDirectory !== undefined) {
			return `${remoteParaCodeDirectory}/${PARADIS_MCP_PORT_FILE_NAME}`;
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
}
