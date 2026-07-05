/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// コマンドプリセット機能の contribution:
//   - 設定スキーマ（paradis.terminal.presets）の登録
//   - IParadisPresetService の登録
//   - ピン留めプリセットのターミナルタブバー（エディタタイトル navigation）ボタン動的登録
//     （プリセット集合が変わるたびに dispose → 再登録。Open Browser ボタンと同じメニュー機構）
//   - コマンドパレット（プリセットを実行 / プリセットを管理）
//   - worktree 作成直後の自動実行ヘルパー（リポジトリレベルは初回に内容の確認を挟む）

import { Codicon } from '../../../../base/common/codicons.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import {
	IParadisPresetService,
	IParadisResolvedPreset,
	PARADIS_PRESET_LAUNCH_MODES,
	PARADIS_PRESETS_SETTING,
	PARADIS_WORKSPACE_PRESET_FILE,
} from '../common/paradisTerminalPresets.js';
import { ParadisPresetService } from './paradisPresetService.js';
import { openParadisPresetEditorDialog } from './paradisPresetEditorDialog.js';

registerSingleton(IParadisPresetService, ParadisPresetService, InstantiationType.Delayed);

const CATEGORY = localize2('paradis.category', "Para Code");

// --- 設定スキーマ --------------------------------------------------------------------------------

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_PRESETS_SETTING]: {
			type: 'array',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.terminal.presets', "ターミナルのコマンドプリセット（ユーザーレベル）。ピン留めするとターミナルタブバーの右側にボタンとして表示されます。[コマンドプリセットを管理](command:paradis.terminal.configurePresets) から GUI で作成・編集できます。リポジトリレベルのプリセットは各リポジトリ直下の .paracode.json に定義できます。"),
			items: {
				type: 'object',
				required: ['name', 'commands'],
				properties: {
					name: { type: 'string', description: localize('paradis.terminal.presets.name', "プリセット名。") },
					description: { type: 'string', description: localize('paradis.terminal.presets.description', "説明（ツールチップに表示）。") },
					commands: {
						type: 'array',
						items: { type: 'string' },
						description: localize('paradis.terminal.presets.commands', "実行するコマンド（上から順）。")
					},
					icon: { type: 'string', description: localize('paradis.terminal.presets.icon', "ボタンの codicon 名（例: rocket, play, server-process）。") },
					cwd: { type: 'string', description: localize('paradis.terminal.presets.cwd', "作業ディレクトリ。相対パスはワークスペースフォルダ基準。") },
					launchMode: {
						type: 'string',
						enum: [...PARADIS_PRESET_LAUNCH_MODES],
						enumDescriptions: [
							localize('paradis.terminal.presets.mode.currentTerminal', "アクティブなターミナルで && 連結して実行"),
							localize('paradis.terminal.presets.mode.newTerminal', "新しいターミナルで && 連結して実行"),
							localize('paradis.terminal.presets.mode.newTerminalEach', "コマンドごとに新しいターミナルで実行"),
							localize('paradis.terminal.presets.mode.split', "エディタグループを分割してコマンドごとに並べる"),
						],
						description: localize('paradis.terminal.presets.launchMode', "起動モード。既定は new-terminal。")
					},
					pinned: { type: 'boolean', default: true, description: localize('paradis.terminal.presets.pinned', "ターミナルタブバー右側にボタンとして表示する。") },
					autoRun: { type: 'boolean', default: false, description: localize('paradis.terminal.presets.autoRun', "「新しいスペース（worktree）を作成」直後に自動実行する。") },
					appliesTo: {
						type: 'array',
						items: { type: 'string' },
						description: localize('paradis.terminal.presets.appliesTo', "このプリセットを有効にするリポジトリ（フォルダ名または絶対パス）。未指定は全リポジトリ。")
					}
				}
			},
			default: []
		}
	}
});

// --- ピン留めプリセットのタブバーボタン動的登録 ---------------------------------------------------

class ParadisPresetButtonsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisPresetButtons';

	private readonly _registrations = this._register(new DisposableStore());

	constructor(
		@IParadisPresetService private readonly presetService: IParadisPresetService,
	) {
		super();
		// プリセットボタン群の並び（タブバー右側）に管理ダイアログの入り口を常設する（プリセット0件でも表示）
		for (const menuId of [MenuId.EditorTitle, MenuId.CompactWindowEditorTitle]) {
			this._register(MenuRegistry.appendMenuItem(menuId, {
				command: {
					id: 'paradis.terminal.configurePresets',
					// allow-any-unicode-next-line
					title: localize('paradis.presetButtons.manage', "コマンドプリセットを管理"),
					icon: Codicon.tools
				},
				group: 'navigation',
				order: 100, // ピン留めプリセットボタン（20〜）の右隣
				when: IsSessionsWindowContext.toNegated()
			}));
		}
		this._register(this.presetService.onDidChangePresets(() => this._update()));
		this._update();
	}

	private _update(): void {
		this._registrations.clear();
		let order = 20; // New Terminal(0) や Open Browser(-10) より右
		for (const preset of this.presetService.presets) {
			if (preset.pinned === false) {
				continue;
			}
			const commandId = `paradis.preset.run.${preset.key}`;
			this._registrations.add(CommandsRegistry.registerCommand(commandId, accessor => {
				return accessor.get(IParadisPresetService).runPreset(preset);
			}));
			const icon = preset.icon ? ThemeIcon.fromId(preset.icon) : Codicon.play;
			const title = preset.description ? `${preset.name} — ${preset.description}` : preset.name;
			for (const menuId of [MenuId.EditorTitle, MenuId.CompactWindowEditorTitle]) {
				this._registrations.add(MenuRegistry.appendMenuItem(menuId, {
					command: { id: commandId, title, icon },
					group: 'navigation',
					order: order,
					when: IsSessionsWindowContext.toNegated()
				}));
			}
			order++;
		}
	}
}

registerWorkbenchContribution2(ParadisPresetButtonsContribution.ID, ParadisPresetButtonsContribution, WorkbenchPhase.AfterRestored);

// --- コマンドパレット ----------------------------------------------------------------------------

interface IPresetQuickPickItem extends IQuickPickItem {
	readonly preset: IParadisResolvedPreset;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.terminal.runPreset',
			title: localize2('paradis.terminal.runPreset', "Run Command Preset..."),
			category: CATEGORY,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const presetService = accessor.get(IParadisPresetService);
		const quickInputService = accessor.get(IQuickInputService);
		const presets = presetService.presets;
		if (presets.length === 0) {
			void accessor.get(IDialogService).info(
				// allow-any-unicode-next-line
				localize('paradis.terminal.noPresets', "コマンドプリセットがまだありません。"),
				// allow-any-unicode-next-line
				localize('paradis.terminal.noPresetsDetail', "「Para Code: コマンドプリセットを管理」から作成できます。"));
			return;
		}
		const picks: IPresetQuickPickItem[] = presets.map(preset => ({
			preset,
			label: preset.name,
			description: preset.source === 'workspace' ? PARADIS_WORKSPACE_PRESET_FILE : undefined,
			detail: preset.commands.join(' && '),
		}));
		const pick = await quickInputService.pick(picks, {
			// allow-any-unicode-next-line
			placeHolder: localize('paradis.terminal.runPresetPlaceholder', "実行するプリセットを選択")
		});
		if (pick) {
			await presetService.runPreset(pick.preset);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.terminal.configurePresets',
			title: localize2('paradis.terminal.configurePresets', "Configure Command Presets..."),
			category: CATEGORY,
			f1: true
		});
	}

	run(accessor: ServicesAccessor): void {
		openParadisPresetEditorDialog(accessor);
	}
});

// --- worktree 作成直後の自動実行 ------------------------------------------------------------------

const AUTORUN_APPROVED_STORAGE_KEY = 'paradis.terminalPresets.autoRunApproved';

/**
 * 指定フォルダで有効な autoRun プリセットを実行する。
 * paradisCreateWorktreeDialog（新しいスペースの作成）から、切り替え完了後に呼ばれる。
 * リポジトリレベル（.paracode.json 由来）のプリセットは、リポジトリを開いただけで任意コマンドが
 * 走る攻撃面になるため、内容（コマンド一覧）ごとの初回承認を挟む。承認は APPLICATION スコープに永続。
 *
 * @param repositoryPath 親リポジトリのルートパス。承認キーに含める（同一リポジトリの worktree 間では
 *   一度の承認で済み、かつ別リポジトリが同名・同内容のプリセットを定義しても承認は流用されない）。
 */
export async function paradisRunAutoRunPresets(accessor: ServicesAccessor, folderUri: URI, repositoryPath: string): Promise<void> {
	const presetService = accessor.get(IParadisPresetService);
	const dialogService = accessor.get(IDialogService);
	const storageService = accessor.get(IStorageService);

	const presets = await presetService.getPresetsForFolder(folderUri);
	for (const preset of presets) {
		if (!preset.autoRun) {
			continue;
		}
		if (preset.source === 'workspace') {
			const approvalKey = `${repositoryPath}:${preset.name}:${hash(preset.commands.join('\n'))}`;
			let approved: string[];
			try {
				approved = JSON.parse(storageService.get(AUTORUN_APPROVED_STORAGE_KEY, StorageScope.APPLICATION, '[]'));
			} catch {
				approved = [];
			}
			if (!approved.includes(approvalKey)) {
				const result = await dialogService.confirm({
					// allow-any-unicode-next-line
					message: localize('paradis.terminal.autoRunConfirm', "リポジトリのプリセット「{0}」を自動実行しますか？", preset.name),
					detail: preset.commands.join('\n'),
					// allow-any-unicode-next-line
					primaryButton: localize('paradis.terminal.autoRunConfirmRun', "実行")
				});
				if (!result.confirmed) {
					continue;
				}
				approved.push(approvalKey);
				storageService.store(AUTORUN_APPROVED_STORAGE_KEY, JSON.stringify(approved), StorageScope.APPLICATION, StorageTarget.MACHINE);
			}
		}
		// 切り替え直後はワークスペースフォルダの反映が完了していないことがあるため、
		// cwd の基準を新しい worktree フォルダに明示する
		await presetService.runPreset(preset, { cwd: folderUri });
	}
}
