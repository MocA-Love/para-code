/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルインスタンス毎の「ペイントークン」を管理するworkbenchサービス。
// terminalInstanceService.ts の createInstance()（全ターミナル生成経路のチョークポイント）から
// PARA-PATCH 1行で呼ばれ、PTY起動前の IShellLaunchConfig.env にトークンとポートファイルパスを注入する。
// ウィンドウリロード時の永続ターミナル再接続（attachPersistentProcess）では env を再注入できないため、
// {persistentProcessId → token} を IStorageService（workspace scope）に永続化して復元する。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, IDisposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { ITerminalInstance, ITerminalInstanceService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { PARADIS_CDP_URL_ENV_VAR, PARADIS_MCP_DEFAULT_PORT, PARADIS_MCP_PORT_FILE_ENV_VAR, PARADIS_MCP_PORT_FILE_NAME, PARADIS_PANE_TOKEN_ENV_VAR } from '../common/paradisAgentBrowser.js';

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

	/**
	 * PTY起動前の {@link IShellLaunchConfig} にペイントークン等のenvを注入する。
	 * `attachPersistentProcess`（永続ターミナル再接続）の場合は注入せず、
	 * インスタンス生成後にストレージからの復元パスに回る。
	 */
	prepareShellLaunchConfig(shellLaunchConfig: IShellLaunchConfig): void;
}

/**
 * {persistentProcessId → token} 永続化マップのストレージキー。
 * APPLICATIONスコープ: ワークスペース切り替え（Para Codeのワークスペース即時切り替えではターミナルが
 * 切り替えを跨いで生き続け、別workspaceのウィンドウへ attachPersistentProcess で再接続される）でも
 * トークンを復元できるようにする。workspaceスコープだと切り替え先のストレージにエントリが無く、
 * ペインがトークンを失って共有（バインド）が二度とできなくなる。persistentProcessId はptyホスト
 * （アプリ全体で共有）内で一意なので、アプリ単位のマップで衝突しない。
 */
const STORAGE_KEY = 'paradis.agentBrowser.paneTokens';

/**
 * 永続化マップの最大エントリ数（古いものから間引く）。APPLICATIONスコープ化でアプリ全体の上限に
 * なったため、多数のワークスペース/永続ターミナル併用でも生存トークンが間引かれない程度に取る。
 * 注意: マップ全体の read-modify-write のため、複数ウィンドウがほぼ同時に書き込むと後勝ちで
 * 片方のエントリが落ちる可能性がある（ストレージ変更はウィンドウ間へ随時同期されるので窓は短い。
 * 失われた場合の影響は「そのペインがリロード後に共有不可」に留まり、ターミナル再作成で回復する）。
 */
const MAX_PERSISTED_ENTRIES = 300;

class ParadisPaneTokenService extends Disposable implements IParadisPaneTokenService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/** createInstance 内で env 注入したがまだインスタンスが生成されていない config → token。 */
	private readonly _pendingTokens = new WeakMap<IShellLaunchConfig, string>();

	private readonly _tokenByInstanceId = new Map<number, string>();
	private readonly _instanceIdByToken = new Map<string, number>();
	private readonly _instanceListeners = this._register(new DisposableMap<number, IDisposable>());

	constructor(
		@ITerminalInstanceService terminalInstanceService: ITerminalInstanceService,
		@IStorageService private readonly storageService: IStorageService,
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

	prepareShellLaunchConfig(shellLaunchConfig: IShellLaunchConfig): void {
		if (shellLaunchConfig.attachPersistentProcess) {
			// 再接続: プロセスは生きていて元のenvを保持しているため注入しない。
			// トークンは _handleInstanceCreated でストレージから復元する。
			return;
		}

		const portFilePath = this._getPortFilePath();
		if (!portFilePath) {
			// デスクトップ以外（userDataPathが無いWeb workbench等）では本機能は無効。
			return;
		}

		const token = generateUuid();
		// 既存の env を壊さないよう新しいオブジェクトにマージする（上書きしない）。
		// PARA_CODE_CDP_URL は固定既定ポート前提の値を注入する（サーバーは同ポートを第一候補で
		// listenする。専有時の動的フォールバック中のみ古くなるが、その場合も get_cdp_endpoint
		// MCPツール／ポートファイル経由で実URLを取得できる）。
		shellLaunchConfig.env = {
			...shellLaunchConfig.env,
			[PARADIS_PANE_TOKEN_ENV_VAR]: token,
			[PARADIS_MCP_PORT_FILE_ENV_VAR]: portFilePath,
			[PARADIS_CDP_URL_ENV_VAR]: `http://127.0.0.1:${PARADIS_MCP_DEFAULT_PORT}/cdp`,
		};
		this._pendingTokens.set(shellLaunchConfig, token);
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
		const shellLaunchConfig = instance.shellLaunchConfig;
		const attach = shellLaunchConfig.attachPersistentProcess;
		if (attach) {
			// 再接続: ストレージから {persistentProcessId → token} を復元してマッピング登録する。
			const token = this._readPersistedTokens()[String(attach.id)];
			if (token) {
				this._registerInstance(instance, token);
			}
			return;
		}

		const token = this._pendingTokens.get(shellLaunchConfig);
		if (!token) {
			return;
		}
		this._registerInstance(instance, token);

		// persistentProcessId はプロセス起動後に確定するため、processReady を待って永続化する。
		void instance.processReady.then(() => {
			if (typeof instance.persistentProcessId === 'number') {
				this._persistToken(instance.persistentProcessId, token);
			}
		}).catch(() => {
			// 起動失敗時は永続化しない（インスタンス破棄時にマッピングも消える）。
		});
	}

	private _registerInstance(instance: ITerminalInstance, token: string): void {
		this._tokenByInstanceId.set(instance.instanceId, token);
		this._instanceIdByToken.set(token, instance.instanceId);
		this._instanceListeners.set(instance.instanceId, instance.onDisposed(() => {
			this._tokenByInstanceId.delete(instance.instanceId);
			this._instanceIdByToken.delete(token);
			this._instanceListeners.deleteAndDispose(instance.instanceId);
			if (typeof instance.persistentProcessId === 'number') {
				this._removePersistedToken(instance.persistentProcessId);
			}
			this._onDidChange.fire();
		}));
		this._onDidChange.fire();
	}

	private _readPersistedTokens(): Record<string, string> {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return {};
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, string>;
			}
		} catch {
			// 壊れたエントリは捨てる
		}
		return {};
	}

	private _writePersistedTokens(map: Record<string, string>): void {
		this.storageService.store(STORAGE_KEY, JSON.stringify(map), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private _persistToken(persistentProcessId: number, token: string): void {
		const map = this._readPersistedTokens();
		map[String(persistentProcessId)] = token;
		// 古いエントリから間引いて肥大化を防ぐ（オブジェクトは挿入順を保持する）。
		const keys = Object.keys(map);
		for (let i = 0; i < keys.length - MAX_PERSISTED_ENTRIES; i++) {
			delete map[keys[i]];
		}
		this._writePersistedTokens(map);
	}

	private _removePersistedToken(persistentProcessId: number): void {
		const map = this._readPersistedTokens();
		if (map[String(persistentProcessId)] !== undefined) {
			delete map[String(persistentProcessId)];
			this._writePersistedTokens(map);
		}
	}
}

registerSingleton(IParadisPaneTokenService, ParadisPaneTokenService, InstantiationType.Delayed);

/**
 * terminalInstanceService.ts の PARA-PATCH 点から呼ばれる薄いヘルパー。
 * ロジック本体（トークン生成・env注入・永続化）はすべて {@link ParadisPaneTokenService} 側にある。
 * ターミナル生成を決して壊さないよう、例外はここで握りつぶす。
 */
export function paradisPrepareTerminalPaneEnv(instantiationService: IInstantiationService, shellLaunchConfig: IShellLaunchConfig): void {
	try {
		instantiationService.invokeFunction(accessor => accessor.get(IParadisPaneTokenService).prepareShellLaunchConfig(shellLaunchConfig));
	} catch {
		// env注入に失敗してもターミナル生成自体は続行させる
	}
}
