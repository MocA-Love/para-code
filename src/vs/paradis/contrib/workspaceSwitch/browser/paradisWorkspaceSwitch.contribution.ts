/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../../workbench/common/views.js';
import { ITerminalEditorService, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { editorGroupToColumn } from '../../../../workbench/services/editor/common/editorGroupColumn.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisEditorSplitTerminalService } from '../../../../workbench/services/editor/common/paradisEditorSplitTerminalService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IParadisAgentStatusStore, IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../common/paradisWorkspaceSwitch.js';
import { IParadisEditorScopeService } from '../common/paradisEditorScope.js';
import { paradisWorkspaceSwitchCommandId, paradisWorkspaceSwitchKeybinding } from '../common/paradisWorkspaceSwitchKeybindings.js';
import { ParadisAgentStatusStore } from './paradisAgentStatusStore.js';
import { ParadisEditorSplitTerminalService } from './paradisEditorSplitTerminalService.js';
import { ParadisEditorScopeService } from './paradisEditorScopeService.js';
import { PARADIS_WORKSPACES_VIEW_ID, ParadisWorkspacesView } from './paradisWorkspacesView.js';
import { ParadisWorkspaceSwitchService } from './paradisWorkspaceSwitchService.js';
import { ParadisWorktreeService } from './paradisWorktreeService.js';
import './paradisTerminalScope.contribution.js';
import './paradisScmInputScope.contribution.js';
import './paradisScmRepoScope.contribution.js';

registerSingleton(IParadisWorkspaceSwitchService, ParadisWorkspaceSwitchService, InstantiationType.Delayed);
registerSingleton(IParadisEditorScopeService, ParadisEditorScopeService, InstantiationType.Delayed);
registerSingleton(IParadisWorktreeService, ParadisWorktreeService, InstantiationType.Delayed);
registerSingleton(IParadisAgentStatusStore, ParadisAgentStatusStore, InstantiationType.Delayed);
registerSingleton(IParadisEditorSplitTerminalService, ParadisEditorSplitTerminalService, InstantiationType.Delayed);

class ParadisEditorScopeStarter implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisEditorScopeStarter';

	constructor(@IParadisEditorScopeService _editorScopeService: IParadisEditorScopeService) { }
}

registerWorkbenchContribution2(ParadisEditorScopeStarter.ID, ParadisEditorScopeStarter, WorkbenchPhase.BlockRestore);

// worktree 自動同期の Para Code 設定 (セクションは windowTransparency 側と同じ 'paradis' に相乗り)
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		'paradis.workspaceSwitch.autoImportWorktrees': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			description: localize('paradis.workspaceSwitch.autoImportWorktrees', "登録済みリポジトリに新しく作成された git worktree を、Workspaces ビューへ自動的に追加します。")
		},
		'paradis.workspaceSwitch.autoRemoveMissingWorktrees': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			description: localize('paradis.workspaceSwitch.autoRemoveMissingWorktrees', "削除された git worktree を Workspaces ビューから自動的に取り除きます。無効にした場合、見つからない worktree はリストに残り、手動で削除できます。")
		},
		'paradis.workspaceSwitch.scopeScmRepositories': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			description: localize('paradis.workspaceSwitch.scopeScmRepositories', "ソース管理ビューの表示を、現在開いているスペース（ワークスペースフォルダ）に関係するリポジトリだけに自動的に絞ります。git 拡張が裏で開いたままの他スペースや worktree の親リポジトリは非表示になります（リポジトリ自体は閉じられないため、ガター差分などの機能はそのまま使えます）。")
		},
		'paradis.editor.openTerminalOnSplit': {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.WINDOW,
			description: localize('paradis.editor.openTerminalOnSplit', "Open and focus a new terminal in an editor group immediately after splitting the editor. Existing terminals are never reused.")
		}
	}
});

const CATEGORY = localize2('paradis.category', "Para Code");

const INITIALIZE_COMMAND_ID = 'paradis.workspaceSwitch.initialize';

/**
 * マルチルート (WORKSPACE) 状態であることを確認し、そうでなければ初期化コマンドへの
 * 誘導つき警告を出す。切り替え機能はワークスペース identity 固定が前提のため、
 * 単一フォルダ / empty 状態では動かさない (詳細は paradisWorkspaceSwitchService.ts)。
 */
function ensureParadisWorkspace(accessor: ServicesAccessor): boolean {
	const contextService = accessor.get(IWorkspaceContextService);
	if (contextService.getWorkbenchState() === WorkbenchState.WORKSPACE) {
		return true;
	}

	const notificationService = accessor.get(INotificationService);
	const commandService = accessor.get(ICommandService);
	notificationService.prompt(
		Severity.Warning,
		localize('paradis.workspaceSwitch.requiresWorkspace', "Para Code repository switching requires a multi-root workspace. Initialize the Para Code workspace first."),
		[{
			label: localize('paradis.workspaceSwitch.initializeAction', "Initialize Workspace"),
			run: () => commandService.executeCommand(INITIALIZE_COMMAND_ID)
		}]
	);
	return false;
}

interface IRepositoryQuickPickItem extends IQuickPickItem {
	readonly repository: IParadisWorkspaceRepository;
}

function toRepositoryPicks(service: IParadisWorkspaceSwitchService): IRepositoryQuickPickItem[] {
	const active = service.activeRepository;
	return service.repositories.map(repository => ({
		repository,
		label: repository.name,
		description: active?.id === repository.id
			? localize('paradis.workspaceSwitch.currentRepository', "Current")
			: undefined,
		detail: repository.uri.fsPath
	}));
}

class ParadisInitializeWorkspaceAction extends Action2 {
	constructor() {
		super({
			id: INITIALIZE_COMMAND_ID,
			title: localize2('paradis.workspaceSwitch.initialize', "Initialize Multi-Repo Workspace"),
			category: CATEGORY,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const contextService = accessor.get(IWorkspaceContextService);
		const notificationService = accessor.get(INotificationService);
		const pathService = accessor.get(IPathService);
		const fileService = accessor.get(IFileService);
		const hostService = accessor.get(IHostService);

		if (contextService.getWorkbenchState() === WorkbenchState.WORKSPACE) {
			notificationService.info(localize('paradis.workspaceSwitch.alreadyWorkspace', "This window is already using a multi-root workspace. Use 'Para Code: Add Repository' to register repositories."));
			return;
		}

		// configPath 固定の .code-workspace を用意して開く。workspace id は configPath から
		// 決まるため、このファイルを使い続ける限り WORKSPACE スコープの状態が安定して共有される。
		const userHome = await pathService.userHome();
		const workspaceFile = joinPath(userHome, '.para-code', 'para.code-workspace');
		if (!(await fileService.exists(workspaceFile))) {
			await fileService.createFile(workspaceFile, VSBuffer.fromString(JSON.stringify({ folders: [] }, undefined, '\t')));
		}

		await hostService.openWindow([{ workspaceUri: workspaceFile }], { forceReuseWindow: true });
	}
}

class ParadisAddRepositoryAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.workspaceSwitch.addRepository',
			title: localize2('paradis.workspaceSwitch.addRepository', "Add Repository..."),
			category: CATEGORY,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		if (!ensureParadisWorkspace(accessor)) {
			return;
		}

		const service = accessor.get(IParadisWorkspaceSwitchService);
		const fileDialogService = accessor.get(IFileDialogService);
		const contextService = accessor.get(IWorkspaceContextService);

		const uris = await fileDialogService.showOpenDialog({
			title: localize('paradis.workspaceSwitch.addRepositoryDialog', "Add Repository"),
			openLabel: localize('paradis.workspaceSwitch.addRepositoryLabel', "Add Repository"),
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: true
		});
		if (!uris || uris.length === 0) {
			return;
		}

		const added: IParadisWorkspaceRepository[] = [];
		for (const uri of uris) {
			added.push(await service.addRepository(uri));
		}

		// まだ何も開いていない (初期化直後の空ワークスペース) なら、最初の登録先へそのまま切り替える
		if (contextService.getWorkspace().folders.length === 0 && added.length > 0) {
			await service.switchRepository(added[0].id);
		}
	}
}

class ParadisSwitchRepositoryAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.workspaceSwitch.switchRepository',
			title: localize2('paradis.workspaceSwitch.switchRepository', "Switch Repository..."),
			category: CATEGORY,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		if (!ensureParadisWorkspace(accessor)) {
			return;
		}

		const service = accessor.get(IParadisWorkspaceSwitchService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);

		if (service.repositories.length === 0) {
			notificationService.prompt(
				Severity.Info,
				localize('paradis.workspaceSwitch.noRepositories', "No repositories are registered yet."),
				[{
					label: localize('paradis.workspaceSwitch.addRepositoryAction', "Add Repository"),
					run: () => commandService.executeCommand('paradis.workspaceSwitch.addRepository')
				}]
			);
			return;
		}

		const pick = await quickInputService.pick(toRepositoryPicks(service), {
			placeHolder: localize('paradis.workspaceSwitch.switchPlaceholder', "Select a repository to switch to")
		});
		if (pick) {
			await service.switchRepository(pick.repository.id);
		}
	}
}

class ParadisRemoveRepositoryAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.workspaceSwitch.removeRepository',
			title: localize2('paradis.workspaceSwitch.removeRepository', "Remove Repository from List..."),
			category: CATEGORY,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IParadisWorkspaceSwitchService);
		const worktreeService = accessor.get(IParadisWorktreeService);
		const quickInputService = accessor.get(IQuickInputService);

		if (service.repositories.length === 0) {
			return;
		}

		const pick = await quickInputService.pick(toRepositoryPicks(service), {
			placeHolder: localize('paradis.workspaceSwitch.removePlaceholder', "Select a repository to remove from the list")
		});
		if (pick) {
			const descendantStateKeys = worktreeService.getKnownWorktreeStateKeys(pick.repository.id);
			await service.removeRepository(pick.repository.id, descendantStateKeys);
		}
	}
}

registerAction2(ParadisInitializeWorkspaceAction);
registerAction2(ParadisAddRepositoryAction);
registerAction2(ParadisSwitchRepositoryAction);
registerAction2(ParadisRemoveRepositoryAction);

// エディタ領域でターミナルを開く/フォーカスする (watermark の Toggle Terminal から使用。
// パネルではなく Toggle Browser と同じ場所 = エディタ内にターミナルを出す)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.terminal.toggleEditorTerminal',
			title: localize2('paradis.terminal.toggleEditorTerminal', "Toggle Terminal in Editor Area"),
			category: CATEGORY,
			f1: true,
			// watermark はキーバインドの無いコマンドを表示しないため必須。
			// ⌥⌘T は upstream (editorCommands.ts) と衝突するため ctrl+cmd+T を使う
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyT,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyT }
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const terminalService = accessor.get(ITerminalService);
		const terminalEditorService = accessor.get(ITerminalEditorService);
		const editorGroupsService = accessor.get(IEditorGroupsService);

		// 「アクティブグループ内の」ターミナルだけを再利用対象にする。ウィンドウ全体から探すと、
		// split 直後の空グループで押したとき他グループの既存ターミナルへフォーカスが飛ぶだけになる
		// (TerminalEditorInput は ForceReveal capability を持つため、viewColumn 未指定の openEditor は
		// 既に開かれているグループ側で再表示される)。新規作成時は viewColumn を明示して
		// 確実にアクティブグループへ開く
		const activeGroup = editorGroupsService.activeGroup;
		const existing = terminalService.instances.find(instance =>
			instance.target === TerminalLocation.Editor &&
			activeGroup.editors.some(editor => editor.resource?.toString() === instance.resource.toString()));
		if (existing) {
			await terminalEditorService.openEditor(existing);
			existing.focus(true);
		} else {
			const instance = await terminalService.createTerminal({ location: { viewColumn: editorGroupToColumn(editorGroupsService, activeGroup) } });
			instance.focus(true);
		}
	}
});

// --- FleetView 風サイドバービュー ---------------------------------------------------------------

const paradisWorkspacesViewIcon = registerIcon('paradis-workspaces-view-icon', Codicon.folderLibrary, localize('paradisWorkspacesViewIcon', 'View icon of the Para Code workspaces view.'));

const PARADIS_WORKSPACES_CONTAINER_ID = 'workbench.view.paradisWorkspaces';

const paradisWorkspacesViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: PARADIS_WORKSPACES_CONTAINER_ID,
	title: localize2('paradis.workspaceSwitch.viewContainer', "Workspaces"),
	icon: paradisWorkspacesViewIcon,
	order: 0,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [PARADIS_WORKSPACES_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: `${PARADIS_WORKSPACES_CONTAINER_ID}.state`,
	hideIfEmpty: false
	// isDefault: 左サイドバーの「既定コンテナ」にする。upstream では Explorer が担うが、fork は
	// Explorer を右(セカンダリ)サイドバー既定に移した (explorerViewlet.ts の PARA-PATCH) ため、
	// 左サイドバーに既定コンテナが1つも無い状態になっていた。その状態だとビルド版の新規起動時に
	// layout.ts の「既定以外のビューレットは復元しない」フォールバックが解決先を失い、保存された
	// 表示状態に関わらず毎回サイドバーが強制非表示 (SIDEBAR_HIDDEN=true) になる
	// (dev 実行は !isBuilt 分岐で免除されるため再現しない)。
}, ViewContainerLocation.Sidebar, { isDefault: true });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: PARADIS_WORKSPACES_VIEW_ID,
	name: localize2('paradis.workspaceSwitch.viewName', "Repositories"),
	containerIcon: paradisWorkspacesViewIcon,
	canMoveView: true,
	canToggleVisibility: false,
	ctorDescriptor: new SyncDescriptor(ParadisWorkspacesView),
	openCommandActionDescriptor: {
		id: 'paradis.workspaceSwitch.showWorkspacesView',
		order: 0
	}
}], paradisWorkspacesViewContainer);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(PARADIS_WORKSPACES_VIEW_ID, {
	content: localize({ key: 'paradis.workspaceSwitch.welcome', comment: ['{Locked="](command:paradis.workspaceSwitch.addRepository)"}'] }, "No repositories registered yet.\n[Add Repository](command:paradis.workspaceSwitch.addRepository)")
});

// ビュータイトルの「+」ボタン
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: {
		id: 'paradis.workspaceSwitch.addRepository',
		title: localize2('paradis.workspaceSwitch.addRepositoryMenu', "Add Repository..."),
		icon: Codicon.add
	},
	when: ContextKeyExpr.equals('view', PARADIS_WORKSPACES_VIEW_ID),
	group: 'navigation',
	order: 1
});

// --- キーバインド (Superset 風のリポジトリ即時切り替え) ------------------------------------------
// mac: ctrl+1..9 (primary) / ctrl+cmd+1..9 (secondary)。win/linux: ctrl+alt+1..9。
// Parachan のデフォルトは既存の built-in / extension デフォルトより高い weight で登録する。
// ユーザーの keybindings.json はデフォルト登録より後に解決されるため、引き続き上書き可能。

for (let index = 1; index <= 9; index++) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: paradisWorkspaceSwitchCommandId(index),
				title: localize2('paradis.workspaceSwitch.switchToRepositoryN', "Switch to Repository {0}", index),
				category: CATEGORY,
				f1: false,
				keybinding: paradisWorkspaceSwitchKeybinding(index)
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const service = accessor.get(IParadisWorkspaceSwitchService);
			const repository = service.repositories[index - 1];
			if (repository) {
				await service.switchRepository(repository.id);
			}
		}
	});
}

async function switchRelative(accessor: ServicesAccessor, delta: number): Promise<void> {
	const service = accessor.get(IParadisWorkspaceSwitchService);
	const repositories = service.repositories;
	if (repositories.length === 0) {
		return;
	}

	const activeIndex = repositories.findIndex(repository => repository.id === service.activeRepository?.id);
	const nextIndex = activeIndex === -1 ? 0 : (activeIndex + delta + repositories.length) % repositories.length;
	await service.switchRepository(repositories[nextIndex].id);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.workspaceSwitch.nextRepository',
			title: localize2('paradis.workspaceSwitch.nextRepository', "Switch to Next Repository"),
			category: CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.BracketRight,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.BracketRight }
			}
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return switchRelative(accessor, 1);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.workspaceSwitch.previousRepository',
			title: localize2('paradis.workspaceSwitch.previousRepository', "Switch to Previous Repository"),
			category: CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.BracketLeft,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.BracketLeft }
			}
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return switchRelative(accessor, -1);
	}
});
