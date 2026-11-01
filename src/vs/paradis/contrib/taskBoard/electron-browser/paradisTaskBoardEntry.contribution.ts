/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import '../browser/media/paradisTaskBoardEntry.css';
import { $, append } from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService, registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ToggleTitleBarConfigAction } from '../../../../workbench/browser/parts/titlebar/titlebarActions.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { PARADIS_TASK_BOARD_BRIDGE_CHANNEL, PARADIS_TASK_BOARD_BRIDGE_ENABLED_SETTING } from '../common/paradisTaskBoardBridge.js';
import { IParadisTaskBoardHostService, PARADIS_TASK_BOARD_HOST_CHANNEL, ParadisTaskBoardOpenResult } from '../common/paradisTaskBoardHost.js';
import { IParadisTaskBoardRelaySessionsService } from './paradisTaskBoardRelaySessionsService.js';

registerMainProcessRemoteService(IParadisTaskBoardHostService, PARADIS_TASK_BOARD_HOST_CHANNEL);

const OPEN_COMMAND_ID = 'paradis.taskBoard.open';
const STOP_COMMAND_ID = 'paradis.taskBoard.stop';
const TITLE_BAR_SETTING_ID = 'paradis.taskBoard.titleBar.enabled';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[TITLE_BAR_SETTING_ID]: {
			type: 'boolean',
			default: true,
			// allow-any-unicode-next-line
			description: localize('paradis.taskBoard.titleBarSetting', "タイトルバーに「タスクボード」ボタンを表示するかどうかを制御します。"),
		},
	},
});

/** 今のスペースの、この PC のフォルダ。SSH の接続先のフォルダや、フォルダを開いていないウィンドウでは undefined。 */
function localSpaceFolder(switchService: IParadisWorkspaceSwitchService, contextService: IWorkspaceContextService): string | undefined {
	const active = switchService.activeRepository?.uri;
	if (active?.scheme === Schemas.file) {
		return active.fsPath;
	}
	return contextService.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath;
}

/** 今のスペースの、この窓の SSH の接続先のフォルダ（`vscode-remote`、authority が同じもの）。 */
function remoteSpaceFolder(switchService: IParadisWorkspaceSwitchService, contextService: IWorkspaceContextService, authority: string): URI | undefined {
	const matches = (uri: URI | undefined) => uri?.scheme === Schemas.vscodeRemote && uri.authority === authority;
	const active = switchService.activeRepository?.uri;
	if (matches(active)) {
		return active;
	}
	return contextService.getWorkspace().folders.find(folder => matches(folder.uri))?.uri;
}

/**
 * 同梱のタスクボードを開く。初めてなら、今のスペースのリポジトリでボードを起こす（ボードの上部のメニューで
 * 切り替えられる）。ボードはエージェントを起動するのに接続口（paradis.taskBoard.bridge.enabled）を使うので、
 * オフなら先にオンにするかを聞く。
 *
 * タイトルバーの「エージェント一覧」(order -999) と「ブラウザ一覧」(-998) の間に並べる。
 */
class ParadisOpenTaskBoardAction extends Action2 {

	constructor() {
		super({
			id: OPEN_COMMAND_ID,
			// allow-any-unicode-next-line
			title: localize2('paradis.taskBoard.open', "タスクボードを開く"),
			category: localize2('paradis.taskBoard.category', "Para Code"),
			f1: true,
			menu: [{
				id: MenuId.TitleBarAdjacentCenter,
				order: -998.5,
				when: ContextKeyExpr.and(
					IsSessionsWindowContext.toNegated(),
					ContextKeyExpr.notEquals(`config.${TITLE_BAR_SETTING_ID}`, false),
				),
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);
		const hostService = accessor.get(IParadisTaskBoardHostService);
		const sharedProcessService = accessor.get(ISharedProcessService);
		const logService = accessor.get(ILogService);
		const relayService = accessor.get(IParadisTaskBoardRelaySessionsService);
		const remoteAuthority = accessor.get(IWorkbenchEnvironmentService).remoteAuthority;
		const switchService = accessor.get(IParadisWorkspaceSwitchService);
		const contextService = accessor.get(IWorkspaceContextService);
		const folder = remoteAuthority === undefined ? localSpaceFolder(switchService, contextService) : undefined;
		const remoteFolder = remoteAuthority !== undefined ? remoteSpaceFolder(switchService, contextService, remoteAuthority) : undefined;
		if (!folder && !remoteFolder) {
			// allow-any-unicode-next-line
			notificationService.info(localize('paradis.taskBoard.noFolder', "タスクボードは、フォルダ（リポジトリ）を開いたウィンドウから開いてください。"));
			return;
		}
		if (configurationService.getValue<boolean>(PARADIS_TASK_BOARD_BRIDGE_ENABLED_SETTING) !== true) {
			const { confirmed } = await dialogService.confirm({
				// allow-any-unicode-next-line
				message: localize('paradis.taskBoard.enableBridge', "タスクボードの接続口をオンにしますか？"),
				detail: remoteFolder
					// allow-any-unicode-next-line
					? localize('paradis.taskBoard.enableBridgeDetailRemote', "タスクボードは、この PC の Para Code の接続口を使って、SSH の接続先でエージェントを起動し、質問や許可に答えます。ボードのワークツリーの作成と、ファイルの読み書きは、このウィンドウの接続を通して接続先で行います。設定の「paradis.taskBoard.bridge.enabled」でいつでもオフにできます。")
					// allow-any-unicode-next-line
					: localize('paradis.taskBoard.enableBridgeDetail', "タスクボードは、この PC の Para Code でエージェントを起動し、質問や許可に答えるために接続口を使います。つなげるのは、Para Code が起動したタスクボードだけです。設定の「paradis.taskBoard.bridge.enabled」でいつでもオフにできます。"),
				// allow-any-unicode-next-line
				primaryButton: localize('paradis.taskBoard.enableBridgeOk', "オンにして開く"),
			});
			if (!confirmed) {
				return;
			}
			await configurationService.updateValue(PARADIS_TASK_BOARD_BRIDGE_ENABLED_SETTING, true, ConfigurationTarget.USER);
		}
		const bridge = sharedProcessService.getChannel(PARADIS_TASK_BOARD_BRIDGE_CHANNEL);
		const register = async (board: { readonly pid: number; readonly key: string; readonly remote?: boolean } | undefined) => {
			// 接続口は、ここで登録した鍵と pid のボードからの要求だけを通す（paradisTaskBoardRelay.ts の G1・G2）
			if (board) {
				await bridge.call('registerBoard', board).catch(error => logService.warn('[ParadisTaskBoard] could not register the board with the bridge', error));
			}
		};
		let result: ParadisTaskBoardOpenResult;
		if (remoteFolder && remoteAuthority !== undefined) {
			result = await openRemoteBoard(hostService, relayService, remoteFolder, remoteAuthority, register);
		} else {
			result = await hostService.open(folder!);
			if (result.ok) {
				await register(result.board);
			}
		}
		if (result.ok) {
			return;
		}
		switch (result.reason) {
			case 'not-bundled':
				// allow-any-unicode-next-line
				notificationService.error(localize('paradis.taskBoard.notBundled', "この Para Code にはタスクボードが入っていません（ソースから動かしている場合は `node build/paradis/taskboard/buildTaskBoard.ts` でビルドしてください）。"));
				return;
			case 'repo-busy':
				// allow-any-unicode-next-line
				notificationService.warn(localize('paradis.taskBoard.repoBusy', "このリポジトリは、ほかに起動したタスクボードで開かれています。そちらを閉じてから開いてください。"));
				return;
			case 'other-board':
				// allow-any-unicode-next-line
				notificationService.warn(localize('paradis.taskBoard.otherBoard', "タスクボードは、別のウィンドウ（この PC のフォルダか、別の SSH の接続先）で開いています。同時に開けるのは 1 つだけです。コマンド「タスクボードを止める」で止めてから開き直してください。"));
				return;
			default:
				// allow-any-unicode-next-line
				notificationService.error(localize('paradis.taskBoard.startFailed', "タスクボードを起動できませんでした: {0}", result.message ?? ''));
		}
	}
}

/**
 * SSH の窓のボードを開く。順番は「REH にセッションを開く → ボードを起こす（pid と鍵を受け取る）→ 鍵を接続口へ登録 →
 * セッションに鍵を結ぶ → 起動の合図を待って窓を出す」。ボードはリポジトリの解決から中継を使うので、登録が済むまで
 * 接続口に断られるが、やり直して起動しきる。途中で失敗したらセッションを閉じる。
 */
async function openRemoteBoard(
	hostService: IParadisTaskBoardHostService,
	relayService: IParadisTaskBoardRelaySessionsService,
	repository: URI,
	authority: string,
	register: (board: { readonly pid: number; readonly key: string; readonly remote?: boolean } | undefined) => Promise<void>,
): Promise<ParadisTaskBoardOpenResult> {
	const prepared = await relayService.prepare(repository);
	if (!prepared.ok) {
		return { ok: false, reason: 'start-failed', message: prepared.message };
	}
	const { sessionId, root } = prepared.value;
	const started = await hostService.startRemote({ sessionId, authority, root });
	if (!started.ok || !started.board) {
		await relayService.close(sessionId);
		return started.ok ? { ok: false, reason: 'start-failed' } : started;
	}
	await register(started.board);
	const bound = await relayService.bind(sessionId, started.board.key);
	if (!bound.ok) {
		await relayService.close(sessionId);
		await hostService.stop();
		return { ok: false, reason: 'start-failed', message: bound.message };
	}
	const opened = await hostService.openRemote(sessionId);
	if (!opened.ok) {
		await relayService.close(sessionId);
	}
	return opened;
}

class ParadisStopTaskBoardAction extends Action2 {

	constructor() {
		super({
			id: STOP_COMMAND_ID,
			// allow-any-unicode-next-line
			title: localize2('paradis.taskBoard.stop', "タスクボードを止める"),
			category: localize2('paradis.taskBoard.category', "Para Code"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IParadisTaskBoardHostService).stop();
	}
}

class ParadisToggleTaskBoardTitleBarAction extends ToggleTitleBarConfigAction {
	constructor() {
		super(
			TITLE_BAR_SETTING_ID,
			// allow-any-unicode-next-line
			localize('paradis.taskBoard.toggleTitleBar', "タスクボード"),
			// allow-any-unicode-next-line
			localize('paradis.taskBoard.toggleTitleBarDescription', "タイトルバーの「タスクボード」ボタンの表示を切り替えます"),
			7.5,
			IsSessionsWindowContext.toNegated(),
		);
	}
}

/**
 * タイトルバーのボタン。見た目は「エージェント一覧」のクラスをそのまま使い、アイコンだけ差し替える。
 * 人の判断待ちの件数のバッジは次の段で出す（今は空のまま）。
 */
class ParadisTaskBoardTitleBarWidget extends BaseActionViewItem {

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('paradis-agent-live-titlebar-widget', 'paradis-task-board-titlebar-widget');
		container.setAttribute('role', 'button');
		append(container, $('span.paradis-agent-live-titlebar-icon.paradis-task-board-titlebar-icon')).setAttribute('aria-hidden', 'true');
		// allow-any-unicode-next-line
		const label = localize('paradis.taskBoard.titleBarLabel', "タスクボード");
		append(container, $('span.paradis-agent-live-titlebar-label')).textContent = label;
		container.setAttribute('aria-label', label);
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), container, label));
	}
}

class ParadisTaskBoardEntryContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisTaskBoardEntry';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(actionViewItemService.register(
			MenuId.TitleBarAdjacentCenter,
			OPEN_COMMAND_ID,
			(action, options) => instantiationService.createInstance(ParadisTaskBoardTitleBarWidget, action, options),
			// イベントを渡すとタイトルバーのツールバーごと作り直されるので渡さない（エージェント一覧と同じ）
			undefined,
		));
	}
}

registerAction2(ParadisOpenTaskBoardAction);
registerAction2(ParadisStopTaskBoardAction);
registerAction2(ParadisToggleTaskBoardTitleBarAction);
registerWorkbenchContribution2(ParadisTaskBoardEntryContribution.ID, ParadisTaskBoardEntryContribution, WorkbenchPhase.AfterRestored);
