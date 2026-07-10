/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブラウザページ⇔ターミナルペインのバインディング状態をworkbench側でキャッシュ・監視する
// electron-browser専用サービス。shared processの PARADIS_AGENT_BROWSER_CHANNEL をポーリング
// （+ bind/unbind操作直後の即時再取得）して、バインディングダイアログ・ツールバーボタン・
// ステータスバー・ペインインジケータへ単一の状態ソースを提供する。
// バインド/解除の実処理もここに集約する（コマンドパレットとダイアログの二重実装を避ける）。

import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import { IParadisMcpSetupRequest, IParadisMcpSetupResult, ParadisMcpCli, IParadisPaneBinding, PARADIS_AGENT_BROWSER_CHANNEL } from '../common/paradisAgentBrowser.js';
import { getParadisCdpUrl, getParadisShimPath } from './paradisMcpSnippets.js';

export const IParadisAgentBrowserBindingModel = createDecorator<IParadisAgentBrowserBindingModel>('paradisAgentBrowserBindingModel');

/** ペインで動いているエージェントCLIのベストエフォート判定結果。 */
export type ParadisPaneAgentKind = 'claude' | 'codex' | 'shell';

/** バインディングUIに表示する1ターミナルペイン分の情報。 */
export interface IParadisPaneDescriptor {
	readonly instanceId: number;
	readonly token: string;
	readonly title: string;
	readonly agentKind: ParadisPaneAgentKind;
	/** このペインのトークンでMCP/CDP接続実績があるか（shared process の listSeenTokens 由来）。 */
	readonly mcpConnected: boolean;
	/** このペインに現在バインドされているページ（あれば）。 */
	readonly binding: IParadisPaneBinding | undefined;
}

/**
 * バインディング状態のキャッシュ + バインド/解除操作の集約サービス（electron-browser専用）。
 */
export interface IParadisAgentBrowserBindingModel {
	readonly _serviceBrand: undefined;

	/** キャッシュされたバインディング/接続実績/ペイン一覧が変化したときに発火する。 */
	readonly onDidChange: Event<void>;

	/** このウィンドウの現在のバインディング一覧（キャッシュ）。 */
	readonly bindings: readonly IParadisPaneBinding[];

	/** 現在のターミナルペイン一覧（トークンを持つもののみ）。 */
	getPanes(): IParadisPaneDescriptor[];

	/** 指定ページにバインドされているバインディング一覧を返す。 */
	getBindingsForPage(pageId: string): IParadisPaneBinding[];

	/** 指定ペイントークンのバインディングを返す。 */
	getBindingForToken(token: string): IParadisPaneBinding | undefined;

	/** shared processから最新状態を再取得する。 */
	refresh(): Promise<void>;

	/**
	 * ページをペインへ共有（バインド）する。既存の共有フロー（確認ダイアログ +
	 * startTrackingPage）を通すため、ユーザーが確認を拒否した場合は false を返す。
	 */
	bindPageToPane(model: IBrowserViewModel, token: string): Promise<boolean>;

	/**
	 * 指定ペインのバインドを解除する。ページがどのペインにもバインドされなくなったら
	 * エージェント共有自体も解除する。
	 */
	unbindPane(model: IBrowserViewModel, token: string): Promise<void>;

	/**
	 * ページの全ペインバインドを解除し、エージェント共有も解除する。
	 * @returns 解除したバインディング数
	 */
	unbindPage(model: IBrowserViewModel): Promise<number>;

	/**
	 * 指定CLI（Claude Code / Codex）にpara-browser・chrome-devtools MCPをユーザーレベルで
	 * 自動登録する（shared process経由）。実行結果を返す。
	 */
	setupMcp(cli: ParadisMcpCli): Promise<IParadisMcpSetupResult>;
}

/** shared processへのポーリング間隔（ms）。IPC1往復の軽い呼び出しのみ。 */
const POLL_INTERVAL = 3000;

class ParadisAgentBrowserBindingModel extends Disposable implements IParadisAgentBrowserBindingModel {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _bindings: readonly IParadisPaneBinding[] = [];
	private _seenTokens = new Set<string>();
	private _pollTimer: number | undefined;

	/**
	 * onDidChange の発火を集約するコアレサ。onAnyInstanceTitleChange はエージェントCLIの
	 * OSCタイトル更新でターミナル数に比例して高頻度発火し、購読側（各ペインのインジケータ等）
	 * の再描画コストもペイン数に比例するため、素通しするとペイン数の二乗で再描画が走る。
	 * scheduleFire は「既に予約済みなら再予約しない」ことで、連続発火下でも一定間隔で
	 * 確実に発火する（trailing debounce の発火飢餓を避ける）。
	 */
	private readonly _fireScheduler = this._register(new RunOnceScheduler(() => this._onDidChange.fire(), 100));

	get bindings(): readonly IParadisPaneBinding[] { return this._bindings; }

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
	) {
		super();

		// ペイン集合・タイトル（エージェント種別判定に使用）の変化はUIの再描画に直結する。
		this._register(this.paneTokenService.onDidChange(() => this.scheduleFire()));
		this._register(this.terminalService.onDidChangeInstances(() => this.scheduleFire()));
		this._register(this.terminalService.onAnyInstanceTitleChange(() => this.scheduleFire()));

		this._pollTimer = mainWindow.setInterval(() => { void this.refresh(); }, POLL_INTERVAL);
		void this.refresh();
	}

	private scheduleFire(): void {
		if (!this._fireScheduler.isScheduled()) {
			this._fireScheduler.schedule();
		}
	}

	getPanes(): IParadisPaneDescriptor[] {
		const result: IParadisPaneDescriptor[] = [];
		for (const instance of this.terminalService.instances) {
			const token = this.paneTokenService.getTokenForInstance(instance.instanceId);
			if (!token) {
				continue;
			}
			result.push({
				instanceId: instance.instanceId,
				token,
				title: instance.title,
				agentKind: detectAgentKind(instance),
				mcpConnected: this._seenTokens.has(token),
				binding: this._bindings.find(b => b.token === token),
			});
		}
		return result;
	}

	getBindingsForPage(pageId: string): IParadisPaneBinding[] {
		return this._bindings.filter(binding => binding.pageId === pageId);
	}

	getBindingForToken(token: string): IParadisPaneBinding | undefined {
		return this._bindings.find(binding => binding.token === token);
	}

	/** このウィンドウのターミナルペインにトークンが1本でも割り当てられているか（renderer内で同期判定）。 */
	private hasAnyPaneToken(): boolean {
		for (const instance of this.terminalService.instances) {
			if (this.paneTokenService.getTokenForInstance(instance.instanceId) !== undefined) {
				return true;
			}
		}
		return false;
	}

	async refresh(): Promise<void> {
		// トークンが1本も無ければ shared process のバインディング/接続実績はこのウィンドウに
		// 関係し得ず、listBindings/listSeenTokens の結果は必ず空へ収束する。ただし直前まで
		// 残っていたキャッシュを空へ落とし切る必要があるため、「トークン0 かつ 手元の
		// bindings/seenTokens も既に空」の両方を満たすときだけ IPC をスキップする。片方でも
		// 非空なら通常どおり取得して確実に空へ収束させ、トークンが1本でも生えれば次の tick で
		// 即座に取得を再開する（interval 自体は止めないのでイベント取りこぼしで固まらない）。
		if (!this.hasAnyPaneToken() && this._bindings.length === 0 && this._seenTokens.size === 0) {
			return;
		}
		try {
			const channel = this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL);
			const [bindings, seenTokens] = await Promise.all([
				channel.call<IParadisPaneBinding[]>('listBindings'),
				channel.call<string[]>('listSeenTokens'),
			]);
			if (this._store.isDisposed) {
				return;
			}
			const changed = JSON.stringify(bindings) !== JSON.stringify(this._bindings)
				|| seenTokens.length !== this._seenTokens.size
				|| seenTokens.some(token => !this._seenTokens.has(token));
			this._bindings = bindings;
			this._seenTokens = new Set(seenTokens);
			if (changed) {
				this.scheduleFire();
			}
		} catch {
			// shared process 未起動等。次のポーリングで再試行される。
		}
	}

	async bindPageToPane(model: IBrowserViewModel, token: string): Promise<boolean> {
		// 既存の共有フロー（確認ダイアログ + startTrackingPage）をそのまま使う。
		// ダイアログが二重に出ないよう、独自の確認は挟まない。
		const shared = await model.setSharedWithAgent(true);
		if (!shared) {
			return false;
		}
		await this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL)
			.call('bind', [token, model.id, { url: model.url, title: model.title }]);
		await this.refresh();
		return true;
	}

	async unbindPane(model: IBrowserViewModel, token: string): Promise<void> {
		await this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL).call('unbind', [token]);
		await this.refresh();
		// どのペインにもバインドされなくなったらエージェント共有自体も解除する。
		if (this.getBindingsForPage(model.id).length === 0) {
			await model.setSharedWithAgent(false);
		}
	}

	async setupMcp(cli: ParadisMcpCli): Promise<IParadisMcpSetupResult> {
		const request: IParadisMcpSetupRequest = {
			cli,
			shimPath: getParadisShimPath(),
			cdpUrl: getParadisCdpUrl(),
		};
		return this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL)
			.call<IParadisMcpSetupResult>('setupMcp', [request]);
	}

	async unbindPage(model: IBrowserViewModel): Promise<number> {
		const channel = this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL);
		const matching = this.getBindingsForPage(model.id);
		for (const binding of matching) {
			await channel.call('unbind', [binding.token]);
		}
		// どのペインにもバインドされなくなったらエージェント共有自体も解除する。
		await model.setSharedWithAgent(false);
		await this.refresh();
		return matching.length;
	}

	override dispose(): void {
		if (this._pollTimer !== undefined) {
			mainWindow.clearInterval(this._pollTimer);
			this._pollTimer = undefined;
		}
		super.dispose();
	}
}

/**
 * ターミナルのタイトル（通常はフォアグラウンドプロセス名を反映する）から、
 * ペインで動いているエージェントCLIをベストエフォートで判定する。
 */
export function detectAgentKind(instance: ITerminalInstance): ParadisPaneAgentKind {
	const title = instance.title.toLowerCase();
	if (title.includes('claude')) {
		return 'claude';
	}
	if (title.includes('codex')) {
		return 'codex';
	}
	return 'shell';
}

registerSingleton(IParadisAgentBrowserBindingModel, ParadisAgentBrowserBindingModel, InstantiationType.Delayed);
