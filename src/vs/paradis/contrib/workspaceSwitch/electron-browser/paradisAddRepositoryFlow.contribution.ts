/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Workspaces ビューの「+」から開く統合フロー (案B: URL直接入力型 QuickInput)。
// URLを貼れば即クローン、何も打たずに下の項目を選べば従来のローカルフォルダ追加。
// クローンは shared process の git チャネル (paradisWorktreeGitChannel.ts) で実行し、
// 進捗は IProgressService の通知 (%表示・キャンセル対応) で見せる。

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { paradisResolveExternalPath } from '../../../common/paradisPathUri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { paradisPickAndAddLocalRepositories } from '../browser/paradisWorkspaceSwitch.contribution.js';
import { IParadisCloneProgressEvent, IParadisCloneRepositoryRequest, PARADIS_ADD_REPOSITORY_FLOW_COMMAND_ID, PARADIS_CLONE_PARENT_DIR_SETTING, paradisParseGitUrl } from '../common/paradisRepositoryClone.js';
import { IParadisWorkspaceSwitchService } from '../common/paradisWorkspaceSwitch.js';
import { PARADIS_WORKTREE_GIT_CHANNEL } from '../common/paradisWorktreeCreate.js';

// クローン先設定 (セクションは既存の 'paradis' に相乗り)
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_CLONE_PARENT_DIR_SETTING]: {
			type: 'string',
			default: '~/github',
			scope: ConfigurationScope.APPLICATION,
			description: localize('paradis.workspaceSwitch.cloneParentDirectory', "リポジトリをURLからクローンするときの保存先の親フォルダ。~ はホームディレクトリに展開されます。空にすると、クローンのたびにフォルダ選択ダイアログで確認します。")
		}
	}
});

type ParadisAddRepositoryFlowItemKind = 'clone' | 'local' | 'changeDestination';

interface IParadisAddRepositoryFlowItem extends IQuickPickItem {
	readonly kind: ParadisAddRepositoryFlowItemKind;
}

type ParadisAddRepositoryFlowResult =
	| { readonly kind: 'clone'; readonly url: string; readonly name: string }
	| { readonly kind: 'local' }
	| { readonly kind: 'changeDestination'; readonly value: string };

class ParadisAddRepositoryFlowAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_ADD_REPOSITORY_FLOW_COMMAND_ID,
			title: localize2('paradis.workspaceSwitch.addRepositoryFlow', "Add Repository (Clone from URL or Local Folder)..."),
			category: localize2('paradis.category', "Para Code"),
			// 「Add Repository...」(browser側) がここへ委譲するため、パレットには出さない
			f1: false
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const clipboardService = accessor.get(IClipboardService);
		const configurationService = accessor.get(IConfigurationService);
		const pathService = accessor.get(IPathService);
		const fileDialogService = accessor.get(IFileDialogService);
		const fileService = accessor.get(IFileService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);
		const sharedProcessService = accessor.get(ISharedProcessService);
		const remoteAgentService = accessor.get(IRemoteAgentService);
		const switchService = accessor.get(IParadisWorkspaceSwitchService);
		const contextService = accessor.get(IWorkspaceContextService);

		// クリップボードに Git URL があればプリフィルする
		let value = '';
		try {
			const clipboardText = (await clipboardService.readText()).trim();
			if (clipboardText.length <= 2048 && paradisParseGitUrl(clipboardText)) {
				value = clipboardText;
			}
		} catch {
			// クリップボードが読めなくてもフローは続行できる
		}

		for (; ;) {
			const result = await this.showPicker(quickInputService, configurationService, value);
			if (!result) {
				return;
			}
			if (result.kind === 'local') {
				await paradisPickAndAddLocalRepositories(switchService, fileDialogService, contextService);
				return;
			}
			if (result.kind === 'changeDestination') {
				const picked = await fileDialogService.showOpenDialog({
					// allow-any-unicode-next-line
					title: localize('paradis.repositoryClone.pickDestination', "クローン先を選択"),
					// allow-any-unicode-next-line
					openLabel: localize('paradis.repositoryClone.pickDestinationLabel', "選択"),
					canSelectFiles: false,
					canSelectFolders: true,
					canSelectMany: false
				});
				if (picked && picked.length > 0) {
					await configurationService.updateValue(PARADIS_CLONE_PARENT_DIR_SETTING, picked[0].fsPath, ConfigurationTarget.USER);
				}
				// 入力途中のURLを保ったままピッカーへ戻る
				value = result.value;
				continue;
			}
			// SSH 接続中だけ「接続先 / このPC」を聞く。キャンセルされたらピッカーへ戻す
			const cloneToRemote = await this.pickCloneLocation(quickInputService, remoteAgentService.getConnection()?.remoteAuthority);
			if (cloneToRemote === undefined) {
				value = result.url;
				continue;
			}
			await this.cloneAndAdd(result.url, result.name, {
				configurationService, pathService, fileDialogService, fileService,
				notificationService, progressService, sharedProcessService, remoteAgentService,
				switchService, contextService, cloneToRemote
			});
			return;
		}
	}

	private showPicker(quickInputService: IQuickInputService, configurationService: IConfigurationService, initialValue: string): Promise<ParadisAddRepositoryFlowResult | undefined> {
		const disposables = new DisposableStore();
		return new Promise<ParadisAddRepositoryFlowResult | undefined>(resolve => {
			const quickPick = disposables.add(quickInputService.createQuickPick<IParadisAddRepositoryFlowItem>({ useSeparators: true }));
			// allow-any-unicode-next-line
			quickPick.title = localize('paradis.repositoryClone.title', "リポジトリを追加");
			// allow-any-unicode-next-line
			quickPick.placeholder = localize('paradis.repositoryClone.placeholder', "GitリポジトリのURLを貼り付け (https:// または git@host:path)、または下の項目を選択");
			quickPick.value = initialValue;

			const updateItems = () => {
				const destinationDisplay = this.cloneParentDirDisplay(configurationService);
				const parsed = paradisParseGitUrl(quickPick.value);
				// 入力値 (URL) はラベルとfuzzyマッチしないため、全項目 alwaysShow で表示を維持する
				const items: (IParadisAddRepositoryFlowItem | { type: 'separator'; label?: string })[] = [];
				if (parsed) {
					items.push({
						kind: 'clone',
						// allow-any-unicode-next-line
						label: `$(repo-clone) ${localize('paradis.repositoryClone.cloneItem', "クローンして追加: {0}", parsed.name)}`,
						description: destinationDisplay ? `${destinationDisplay}/${parsed.name}` : undefined,
						alwaysShow: true
					});
					// allow-any-unicode-next-line
					items.push({ type: 'separator', label: localize('paradis.repositoryClone.otherSeparator', "その他") });
				}
				items.push({
					kind: 'local',
					// allow-any-unicode-next-line
					label: `$(folder) ${localize('paradis.repositoryClone.localItem', "ローカルフォルダを追加...")}`,
					alwaysShow: true
				});
				items.push({
					kind: 'changeDestination',
					// allow-any-unicode-next-line
					label: `$(gear) ${localize('paradis.repositoryClone.destinationItem', "クローン先を変更...")}`,
					description: destinationDisplay
						// allow-any-unicode-next-line
						? localize('paradis.repositoryClone.destinationCurrent', "現在: {0}", destinationDisplay)
						// allow-any-unicode-next-line
						: localize('paradis.repositoryClone.destinationAsk', "現在: 毎回確認"),
					alwaysShow: true
				});
				quickPick.items = items as (IParadisAddRepositoryFlowItem | { type: 'separator' })[];
				const firstItem = quickPick.items.find((item): item is IParadisAddRepositoryFlowItem => !('type' in item && item.type === 'separator'));
				quickPick.activeItems = firstItem ? [firstItem] : [];
			};

			disposables.add(quickPick.onDidChangeValue(() => updateItems()));
			disposables.add(quickPick.onDidAccept(() => {
				const item = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
				if (!item) {
					return;
				}
				if (item.kind === 'clone') {
					const url = quickPick.value.trim();
					const parsed = paradisParseGitUrl(url);
					if (!parsed) {
						return;
					}
					resolve({ kind: 'clone', url, name: parsed.name });
				} else if (item.kind === 'local') {
					resolve({ kind: 'local' });
				} else {
					resolve({ kind: 'changeDestination', value: quickPick.value });
				}
				quickPick.hide();
			}));
			disposables.add(quickPick.onDidHide(() => {
				disposables.dispose();
				resolve(undefined);
			}));

			updateItems();
			quickPick.show();
		});
	}

	/** クローン先設定の生の表示文字列 ('~/github' 等)。未設定・空なら undefined。 */
	private cloneParentDirDisplay(configurationService: IConfigurationService): string | undefined {
		const raw = configurationService.getValue<unknown>(PARADIS_CLONE_PARENT_DIR_SETTING);
		const trimmed = typeof raw === 'string' ? raw.trim() : '';
		return trimmed.length > 0 ? trimmed : undefined;
	}

	/**
	 * クローン先の親ディレクトリを解決する。設定が空ならフォルダ選択ダイアログで確認する。
	 *
	 * `cloneToRemote` は「接続先へクローンする」が選ばれたかどうか。`~` の展開先が変わる:
	 * 接続先なら接続先のホーム、手元なら手元のホームを基準にする。git を実際に動かす側と
	 * ここが食い違うと、存在しないパスを掘ろうとして ENOENT になる。
	 */
	private async resolveCloneParentDir(configurationService: IConfigurationService, pathService: IPathService, fileDialogService: IFileDialogService, cloneToRemote: boolean): Promise<URI | undefined> {
		const raw = this.cloneParentDirDisplay(configurationService);
		if (raw) {
			const userHome = cloneToRemote ? await pathService.userHome() : pathService.userHome({ preferLocal: true });
			if (raw === '~' || raw.startsWith('~/')) {
				return raw === '~' ? userHome : joinPath(userHome, raw.substring(2));
			}
			// `~` 展開と同じ名前空間で解決する (リモートウィンドウでローカルの file: を
			// 強制すると、クローン先だけが別マシンを指してしまう)。
			// 解決できない設定値でも従来どおり file: として扱う。ここで undefined を返すと
			// 呼び出し側の「ダイアログでキャンセルされた」経路に合流し、無言で何も起きなくなる
			return paradisResolveExternalPath(userHome, raw) ?? URI.file(raw);
		}
		const picked = await fileDialogService.showOpenDialog({
			// allow-any-unicode-next-line
			title: localize('paradis.repositoryClone.pickDestination', "クローン先を選択"),
			// allow-any-unicode-next-line
			openLabel: localize('paradis.repositoryClone.pickDestinationLabel', "選択"),
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false
		});
		return picked?.[0];
	}

	/**
	 * クローン先を「接続先」と「手元」から選ばせる。SSH 接続していないときは聞かずに手元。
	 *
	 * 接続先を選ぶと git は接続先で動く（REH に生やした同名チャネル経由）。手元を選ぶと
	 * 従来どおり shared process で動く。
	 */
	private async pickCloneLocation(quickInputService: IQuickInputService, remoteAuthority: string | undefined): Promise<boolean | undefined> {
		if (!remoteAuthority) {
			return false;
		}
		const remoteLabel = remoteAuthority.replace(/^ssh-remote\+/, '');
		type LocationItem = IQuickPickItem & { readonly toRemote: boolean };
		const picked = await quickInputService.pick<LocationItem>([
			// allow-any-unicode-next-line
			{ label: localize('paradis.repositoryClone.toRemote', "接続先"), description: remoteLabel, toRemote: true },
			// allow-any-unicode-next-line
			{ label: localize('paradis.repositoryClone.toLocal', "このPC"), toRemote: false }
		], {
			// allow-any-unicode-next-line
			title: localize('paradis.repositoryClone.locationTitle', "どこにクローンしますか"),
			ignoreFocusLost: true
		});
		return picked?.toRemote;
	}

	private async cloneAndAdd(url: string, name: string, services: {
		configurationService: IConfigurationService;
		pathService: IPathService;
		fileDialogService: IFileDialogService;
		fileService: IFileService;
		notificationService: INotificationService;
		progressService: IProgressService;
		sharedProcessService: ISharedProcessService;
		remoteAgentService: IRemoteAgentService;
		switchService: IParadisWorkspaceSwitchService;
		contextService: IWorkspaceContextService;
		cloneToRemote: boolean;
	}): Promise<void> {
		const { configurationService, pathService, fileDialogService, fileService, notificationService, progressService, sharedProcessService, remoteAgentService, switchService, contextService, cloneToRemote } = services;

		const parentDir = await this.resolveCloneParentDir(configurationService, pathService, fileDialogService, cloneToRemote);
		if (!parentDir) {
			return;
		}
		const target = joinPath(parentDir, name);

		// 同じパスが登録済みならクローンせず、そのリポジトリへ切り替える (Superset と同じ挙動)。
		// fsPath 比較だと scheme/authority を無視するため、リモートとローカルで同じパスのものを
		// 取り違える (クローン先がリモートになり得るようになったので実際に起こる)
		const existing = switchService.repositories.find(repository => extUriBiasedIgnorePathCase.isEqual(repository.uri, target));
		if (existing) {
			// allow-any-unicode-next-line
			notificationService.info(localize('paradis.repositoryClone.alreadyRegistered', "{0} は登録済みです。そのリポジトリへ切り替えます。", existing.name));
			await switchService.switchRepository(existing.id);
			return;
		}
		if (await fileService.exists(target)) {
			// allow-any-unicode-next-line
			notificationService.error(localize('paradis.repositoryClone.folderExists', "\"{0}\" という名前のフォルダが {1} に既に存在します。クローン先を変更するか、ローカルフォルダとして追加してください。", name, parentDir.fsPath));
			return;
		}

		const cloneId = generateUuid();
		// 接続先を選んだときは REH 側の同名チャネルへ。手元なら従来どおり shared process。
		const remoteConnection = cloneToRemote ? remoteAgentService.getConnection() : undefined;
		if (cloneToRemote && !remoteConnection) {
			// allow-any-unicode-next-line
			notificationService.error(localize('paradis.repositoryClone.noRemoteConnection', "接続先との接続が切れているため、接続先へクローンできません。"));
			return;
		}
		const channel = remoteConnection
			? remoteConnection.getChannel(PARADIS_WORKTREE_GIT_CHANNEL)
			: sharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL);
		try {
			await progressService.withProgress({
				location: ProgressLocation.Notification,
				// allow-any-unicode-next-line
				title: localize('paradis.repositoryClone.progressTitle', "{0} をクローンしています", url),
				cancellable: true
			}, async progress => {
				const listeners = new DisposableStore();
				try {
					// 購読要求の到達より先に shared process 側が最初の進捗を fire した場合、
					// その分は取りこぼすが表示のみの影響 (完了判定は call の resolve で行う)
					let lastPercent = 0;
					listeners.add(channel.listen<IParadisCloneProgressEvent>('onCloneProgress')(event => {
						if (event.cloneId !== cloneId) {
							return;
						}
						const increment = Math.max(0, event.overallPercent - lastPercent);
						lastPercent = Math.max(lastPercent, event.overallPercent);
						progress.report({ message: event.message, increment });
					}));
					const request: IParadisCloneRepositoryRequest = { url, targetPath: target.fsPath, cloneId };
					await channel.call('cloneRepository', [request]);
				} finally {
					listeners.dispose();
				}
			}, () => {
				void channel.call('cancelClone', [cloneId]);
			});
		} catch (error) {
			if (!isCancellationError(error)) {
				// allow-any-unicode-next-line
				notificationService.error(localize('paradis.repositoryClone.failedNotification', "{0} のクローンに失敗しました: {1}", url, toErrorMessage(error)));
			}
			return;
		}

		const added = await switchService.addRepository(target);
		// まだ何も開いていない (初期化直後の空ワークスペース) なら、そのまま切り替える
		if (contextService.getWorkspace().folders.length === 0) {
			await switchService.switchRepository(added.id);
		} else {
			// allow-any-unicode-next-line
			notificationService.info(localize('paradis.repositoryClone.done', "{0} をクローンして Workspaces に追加しました。", added.name));
		}
	}
}

registerAction2(ParadisAddRepositoryFlowAction);
