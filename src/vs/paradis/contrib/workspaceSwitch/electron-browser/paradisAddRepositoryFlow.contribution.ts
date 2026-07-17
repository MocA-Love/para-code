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
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
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
					title: localize('paradis.repositoryClone.pickDestination', "Select Clone Destination"),
					openLabel: localize('paradis.repositoryClone.pickDestinationLabel', "Select"),
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
			await this.cloneAndAdd(result.url, result.name, {
				configurationService, pathService, fileDialogService, fileService,
				notificationService, progressService, sharedProcessService, switchService, contextService
			});
			return;
		}
	}

	private showPicker(quickInputService: IQuickInputService, configurationService: IConfigurationService, initialValue: string): Promise<ParadisAddRepositoryFlowResult | undefined> {
		const disposables = new DisposableStore();
		return new Promise<ParadisAddRepositoryFlowResult | undefined>(resolve => {
			const quickPick = disposables.add(quickInputService.createQuickPick<IParadisAddRepositoryFlowItem>({ useSeparators: true }));
			quickPick.title = localize('paradis.repositoryClone.title', "Add Repository");
			quickPick.placeholder = localize('paradis.repositoryClone.placeholder', "Paste a Git repository URL (https:// or git@host:path), or pick an option below");
			quickPick.value = initialValue;

			const updateItems = () => {
				const destinationDisplay = this.cloneParentDirDisplay(configurationService);
				const parsed = paradisParseGitUrl(quickPick.value);
				// 入力値 (URL) はラベルとfuzzyマッチしないため、全項目 alwaysShow で表示を維持する
				const items: (IParadisAddRepositoryFlowItem | { type: 'separator'; label?: string })[] = [];
				if (parsed) {
					items.push({
						kind: 'clone',
						label: `$(repo-clone) ${localize('paradis.repositoryClone.cloneItem', "Clone and Add: {0}", parsed.name)}`,
						description: destinationDisplay ? `${destinationDisplay}/${parsed.name}` : undefined,
						alwaysShow: true
					});
					items.push({ type: 'separator', label: localize('paradis.repositoryClone.otherSeparator', "Other") });
				}
				items.push({
					kind: 'local',
					label: `$(folder) ${localize('paradis.repositoryClone.localItem', "Add Local Folder...")}`,
					alwaysShow: true
				});
				items.push({
					kind: 'changeDestination',
					label: `$(gear) ${localize('paradis.repositoryClone.destinationItem', "Change Clone Destination...")}`,
					description: destinationDisplay
						? localize('paradis.repositoryClone.destinationCurrent', "Current: {0}", destinationDisplay)
						: localize('paradis.repositoryClone.destinationAsk', "Currently asking every time"),
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

	/** クローン先の親ディレクトリを解決する。設定が空ならフォルダ選択ダイアログで確認する。 */
	private async resolveCloneParentDir(configurationService: IConfigurationService, pathService: IPathService, fileDialogService: IFileDialogService): Promise<URI | undefined> {
		const raw = this.cloneParentDirDisplay(configurationService);
		if (raw) {
			if (raw === '~' || raw.startsWith('~/')) {
				const userHome = await pathService.userHome();
				return raw === '~' ? userHome : joinPath(userHome, raw.substring(2));
			}
			return URI.file(raw);
		}
		const picked = await fileDialogService.showOpenDialog({
			title: localize('paradis.repositoryClone.pickDestination', "Select Clone Destination"),
			openLabel: localize('paradis.repositoryClone.pickDestinationLabel', "Select"),
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false
		});
		return picked?.[0];
	}

	private async cloneAndAdd(url: string, name: string, services: {
		configurationService: IConfigurationService;
		pathService: IPathService;
		fileDialogService: IFileDialogService;
		fileService: IFileService;
		notificationService: INotificationService;
		progressService: IProgressService;
		sharedProcessService: ISharedProcessService;
		switchService: IParadisWorkspaceSwitchService;
		contextService: IWorkspaceContextService;
	}): Promise<void> {
		const { configurationService, pathService, fileDialogService, fileService, notificationService, progressService, sharedProcessService, switchService, contextService } = services;

		const parentDir = await this.resolveCloneParentDir(configurationService, pathService, fileDialogService);
		if (!parentDir) {
			return;
		}
		const target = joinPath(parentDir, name);

		// 同じパスが登録済みならクローンせず、そのリポジトリへ切り替える (Superset と同じ挙動)
		const existing = switchService.repositories.find(repository => repository.uri.fsPath === target.fsPath);
		if (existing) {
			notificationService.info(localize('paradis.repositoryClone.alreadyRegistered', "{0} is already registered. Switching to it.", existing.name));
			await switchService.switchRepository(existing.id);
			return;
		}
		if (await fileService.exists(target)) {
			notificationService.error(localize('paradis.repositoryClone.folderExists', "A folder named \"{0}\" already exists in {1}. Choose a different destination or add it as a local folder.", name, parentDir.fsPath));
			return;
		}

		const cloneId = generateUuid();
		const channel = sharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL);
		try {
			await progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('paradis.repositoryClone.progressTitle', "Cloning {0}", url),
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
				notificationService.error(localize('paradis.repositoryClone.failedNotification', "Failed to clone {0}: {1}", url, toErrorMessage(error)));
			}
			return;
		}

		const added = await switchService.addRepository(target);
		// まだ何も開いていない (初期化直後の空ワークスペース) なら、そのまま切り替える
		if (contextService.getWorkspace().folders.length === 0) {
			await switchService.switchRepository(added.id);
		} else {
			notificationService.info(localize('paradis.repositoryClone.done', "Cloned {0} and added it to Workspaces.", added.name));
		}
	}
}

registerAction2(ParadisAddRepositoryFlowAction);
