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
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { ITerminalInstance, ITerminalInstanceService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paneTokenFromShellIntegrationNonce, restoredPaneToken } from '../../mobileRelay/common/paradisTerminalPersistence.js';
import { IParadisCodexPaneRuntime, paradisCodexPaneSocketPath, paradisCreateTerminalPaneEnvironment, PARADIS_MCP_PORT_FILE_NAME } from '../common/paradisAgentBrowser.js';
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
	 * PTY起動前の {@link IShellLaunchConfig} にペイントークン等のenvを注入する。
	 * `attachPersistentProcess`（永続ターミナル再接続）の場合は元のPTY環境を保持するため
	 * envを変更せず、インスタンス生成後にrevive済みnonceから対応を復元する。
	 */
	prepareShellLaunchConfig(shellLaunchConfig: IShellLaunchConfig): void;
}

class ParadisPaneTokenService extends Disposable implements IParadisPaneTokenService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _tokenByInstanceId = new Map<number, string>();
	private readonly _instanceIdByToken = new Map<string, number>();
	private readonly _instanceListeners = this._register(new DisposableMap<number, IDisposable>());

	constructor(
		@ITerminalInstanceService terminalInstanceService: ITerminalInstanceService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
	) {
		super();

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

	private _getCodexRuntime(token: string): IParadisCodexPaneRuntime | undefined {
		if (isWindows) {
			return undefined;
		}
		const desktopEnvironment = this.environmentService as IWorkbenchEnvironmentService & {
			readonly appRoot?: string;
			readonly userDataPath?: string;
		};
		const { appRoot, userDataPath } = desktopEnvironment;
		if (typeof appRoot !== 'string' || typeof userDataPath !== 'string') {
			return undefined;
		}
		const socketPath = paradisCodexPaneSocketPath(userDataPath, token);
		if (socketPath === undefined) {
			return undefined;
		}
		return {
			launcherDirectory: join(appRoot, 'resources', 'paradis', 'bin'),
			socketPath,
			pathDelimiter: ':',
		};
	}

	private _getPortFilePath(): string | undefined {
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
