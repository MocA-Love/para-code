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

import './media/paradisPresetToolbar.css';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import {
	IParadisPresetService,
	IParadisResolvedPreset,
	paradisPresetApprovalSignature,
	paradisPresetCommandSignature,
	paradisPresetQualifiers,
	paradisPresetTooltip,
	PARADIS_PRESET_LAUNCH_MODES,
	PARADIS_PRESET_LAYOUTS,
	PARADIS_PRESETS_SETTING,
	PARADIS_PROJECT_ROOT_ENV_VAR,
	PARADIS_WORKSPACE_PRESET_FILE,
} from '../common/paradisTerminalPresets.js';
import { ParadisPresetService } from './paradisPresetService.js';
import { openParadisPresetEditorDialog } from './paradisPresetEditorDialog.js';
import { ParadisPresetClusterViewItem } from './paradisPresetClusterViewItem.js';

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
				required: ['name'],
				properties: {
					id: { type: 'string', description: localize('paradis.terminal.presets.id', "識別子。GUI で保存すると自動で入ります（手で書く必要はありません）。名前は識別子ではないため、同じ名前のプリセットを複数登録できます。") },
					name: { type: 'string', description: localize('paradis.terminal.presets.name', "プリセット名。同じ名前を複数のプリセットに付けられます。") },
					description: { type: 'string', description: localize('paradis.terminal.presets.description', "説明（ツールチップに表示）。") },
					commands: {
						type: 'array',
						items: { type: 'string' },
						description: localize('paradis.terminal.presets.commands', "旧形式: 実行するコマンド（上から順）。tasks があればそちらが優先。")
					},
					tasks: {
						type: 'array',
						description: localize('paradis.terminal.presets.tasks', "タスク（＝ターミナル）ごとのコマンド定義。1タスクにつき1ターミナルが起動する。"),
						items: {
							type: 'object',
							required: ['commands'],
							properties: {
								name: { type: 'string', description: localize('paradis.terminal.presets.tasks.name', "ターミナルのタイトル。未指定はプリセット名。") },
								cwd: { type: 'string', description: localize('paradis.terminal.presets.tasks.cwd', "作業ディレクトリ。相対パスはワークスペースフォルダ基準。") },
								commands: {
									type: 'array',
									items: { type: 'string' },
									description: localize('paradis.terminal.presets.tasks.commands', "このターミナルで実行するコマンド（上から順、失敗時は後続を実行しない）。")
								}
							}
						}
					},
					layout: {
						type: 'string',
						enum: [...PARADIS_PRESET_LAYOUTS],
						enumDescriptions: [
							localize('paradis.terminal.presets.layout.tabs', "タスクごとのターミナルをタブとして並べる"),
							localize('paradis.terminal.presets.layout.split', "エディタグループを分割してタスクごとに並べる"),
							localize('paradis.terminal.presets.layout.current', "全コマンドを連結してアクティブなターミナルで実行"),
						],
						description: localize('paradis.terminal.presets.layout', "タスク群（＝ターミナル群）の並べ方。既定は tabs。")
					},
					icon: { type: 'string', description: localize('paradis.terminal.presets.icon', "ボタンの codicon 名（例: rocket, play, server-process）。") },
					folder: { type: 'string', description: localize('paradis.terminal.presets.folder', "所属フォルダ名。同じ名前の値を持つプリセット同士が、一覧でフォルダとしてまとめて表示される。") },
					cwd: { type: 'string', description: localize('paradis.terminal.presets.cwd', "既定の作業ディレクトリ。相対パスはワークスペースフォルダ基準。") },
					launchMode: {
						type: 'string',
						enum: [...PARADIS_PRESET_LAUNCH_MODES],
						enumDescriptions: [
							localize('paradis.terminal.presets.mode.currentTerminal', "アクティブなターミナルで && 連結して実行"),
							localize('paradis.terminal.presets.mode.newTerminal', "新しいターミナルで && 連結して実行"),
							localize('paradis.terminal.presets.mode.newTerminalEach', "コマンドごとに新しいターミナルで実行"),
							localize('paradis.terminal.presets.mode.split', "エディタグループを分割してコマンドごとに並べる"),
						],
						description: localize('paradis.terminal.presets.launchMode', "旧形式: 起動モード。既定は new-terminal。tasks があれば無視される。")
					},
					pinned: { type: 'boolean', default: true, description: localize('paradis.terminal.presets.pinned', "ターミナルタブバー右側にボタンとして表示する。") },
					pinnedLabel: { type: 'boolean', default: false, description: localize('paradis.terminal.presets.pinnedLabel', "ピン留めボタンにアイコンに加えて名前も表示する。") },
					autoRun: { type: 'boolean', default: false, description: localize('paradis.terminal.presets.autoRun', "「新しいスペース（worktree）を作成」直後に自動実行する。実行時は環境変数 {0} に親リポジトリの絶対パスが渡される。", PARADIS_PROJECT_ROOT_ENV_VAR) },
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

/** タブバー右側のドロップダウン（全プリセットの一覧）のメニュー。 */
const ParadisPresetsSubmenu = new MenuId('paradisPresetsSubmenu');

/**
 * ピン留めプリセット群をまとめて描画するクラスターの登録先コマンド。実際にクリックされるのは
 * 個々のプリセットのボタン（ParadisPresetClusterViewItem が直接 runPreset を呼ぶ）であって、
 * このコマンド自体が実行されることは想定していない——MenuId にアクションを1つも登録しないと
 * ツールバーにスロット自体が生まれず、カスタムのビューアイテムを差し込む場所が無いための器。
 */
const PARADIS_PRESET_CLUSTER_COMMAND_ID = 'paradis.terminal.presetCluster';
CommandsRegistry.registerCommand(PARADIS_PRESET_CLUSTER_COMMAND_ID, () => {
	// ParadisPresetClusterViewItem が描画・クリックの両方を乗っ取るため、通常はここに来ない。
});

class ParadisPresetButtonsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisPresetButtons';

	private readonly _registrations = this._register(new DisposableStore());

	constructor(
		@IParadisPresetService private readonly presetService: IParadisPresetService,
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		for (const menuId of [MenuId.EditorTitle, MenuId.CompactWindowEditorTitle]) {
			// ピン留めプリセット群（幅に応じて1個のアイコンへ折りたたむクラスター）。プリセットが
			// 0件のときはビューアイテム自身が非表示にする（container.style.display = 'none'）。
			// MenuItem の登録・解除では表現しない——出し入れのたびにツールバーごと作り直されて
			// ちらつく（タイトルバーの「エージェント一覧」ウィジェットが同じ理由で event を
			// 渡していないのと同様）。
			this._register(MenuRegistry.appendMenuItem(menuId, {
				command: {
					id: PARADIS_PRESET_CLUSTER_COMMAND_ID,
					// allow-any-unicode-next-line
					title: localize('paradis.presetButtons.cluster', "コマンドプリセット"),
				},
				group: 'navigation',
				order: 20, // New Terminal(0) や Open Browser(-10) より右
				when: IsSessionsWindowContext.toNegated()
			}));
			this._register(actionViewItemService.register(menuId, PARADIS_PRESET_CLUSTER_COMMAND_ID, (action, options) =>
				instantiationService.createInstance(ParadisPresetClusterViewItem, action, options)));

			// 全プリセットのドロップダウン（ピン留めの有無に関わらず全件を集約する入り口）
			this._register(MenuRegistry.appendMenuItem(menuId, {
				submenu: ParadisPresetsSubmenu,
				// allow-any-unicode-next-line
				title: localize('paradis.presetButtons.dropdown', "コマンドプリセット"),
				icon: Codicon.play,
				group: 'navigation',
				order: 99, // クラスター（20）の右、管理ボタン（100）の左
				when: IsSessionsWindowContext.toNegated()
			}));
			// プリセットボタン群の並び（タブバー右側）に管理ダイアログの入り口を常設する（プリセット0件でも表示）
			this._register(MenuRegistry.appendMenuItem(menuId, {
				command: {
					id: 'paradis.terminal.configurePresets',
					// allow-any-unicode-next-line
					title: localize('paradis.presetButtons.manage', "コマンドプリセットを管理"),
					icon: Codicon.tools
				},
				group: 'navigation',
				order: 100,
				when: IsSessionsWindowContext.toNegated()
			}));
		}
		// プリセット変更イベントはフォルダ再読込などで連続で飛んでくるため、再構築は debounce して1回に合流させる
		// （「全プリセット」ドロップダウンの中身の dispose→再登録がイベントごとに走ると無駄な再計算になる。
		// クラスター自体の見た目はここではなく ParadisPresetClusterViewItem が自前で購読して更新する）
		const updateScheduler = this._register(new RunOnceScheduler(() => this._update(), 50));
		this._register(this.presetService.onDidChangePresets(() => updateScheduler.schedule()));
		this._update();
	}

	/** 「全プリセット」ドロップダウン（ParadisPresetsSubmenu）の実行コマンドとメニュー項目だけを持つ。 */
	private _update(): void {
		this._registrations.clear();
		const presets = this.presetService.presets;
		const qualifiers = paradisPresetQualifiers(presets);
		for (const preset of presets) {
			const commandId = `paradis.preset.run.${preset.key}`;
			this._registrations.add(CommandsRegistry.registerCommand(commandId, accessor =>
				accessor.get(IParadisPresetService).runPreset(preset)));
			const qualifier = qualifiers.get(preset.key);
			const title = qualifier ? `${preset.name} (${qualifier})` : preset.name;

			// ドロップダウンには全プリセットを列挙（リポジトリ由来 → ユーザー由来の順）
			this._registrations.add(MenuRegistry.appendMenuItem(ParadisPresetsSubmenu, {
				command: { id: commandId, title, tooltip: paradisPresetTooltip(preset, qualifier) },
				group: preset.source === 'workspace' ? '1_workspace' : '2_user',
			}));
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
		// 同名が並ぶときは区別語を description に載せる（VS Code の一覧の作法どおり、
		// label は名前のまま、補足は description、実行内容は detail）。
		const qualifiers = paradisPresetQualifiers(presets);
		const picks: IPresetQuickPickItem[] = presets.map(preset => ({
			preset,
			label: preset.name,
			description: [qualifiers.get(preset.key), preset.source === 'workspace' ? PARADIS_WORKSPACE_PRESET_FILE : undefined]
				.filter((part): part is string => !!part).join(' · ') || undefined,
			detail: paradisPresetCommandSignature(preset, ' && '),
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
 * @param stateKey 実行対象の状態キー（worktree 作成直後など、現在PC側でアクティブなスコープとは
 *   限らない）。指定すると生成されたターミナルをこのスコープへ明示的に紐付ける（呼び出し元が
 *   `paradisCreateWorktreeDialog` の場合、setup スクリプト実行中にユーザーが別スコープへ
 *   切り替えても、完成したターミナルが誤って「今アクティブな」スコープに表示されるのを防ぐ）。
 * @returns 実際に1つ以上のプリセットを実行したか（呼び出し側がデフォルト端末の要否を判断するために使う）。
 */
export async function paradisRunAutoRunPresets(accessor: ServicesAccessor, folderUri: URI, repositoryPath: string, stateKey?: string): Promise<boolean> {
	const presetService = accessor.get(IParadisPresetService);
	const dialogService = accessor.get(IDialogService);
	const storageService = accessor.get(IStorageService);
	const logService = accessor.get(ILogService);

	let ranAny = false;
	const presets = await presetService.getPresetsForFolder(folderUri);
	for (const preset of presets) {
		if (!preset.autoRun) {
			continue;
		}
		if (preset.source === 'workspace') {
			const approvalKey = `${repositoryPath}:${preset.name}:${hash(paradisPresetApprovalSignature(preset))}`;
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
					detail: paradisPresetCommandSignature(preset),
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
		try {
			await presetService.runPreset(preset, {
				cwd: folderUri,
				// 切り替え元の park 済み端末が activeInstance に残っていても再利用しない。
				forceNewTerminal: true,
				stateKey,
				// setup スクリプトと同じ環境変数を渡す（同じ .paracode.json に書いたコマンドでも、
				// setupScript か autoRun プリセットかで親リポジトリのパスを取れたり取れなかったり
				// する食い違いをなくす）。
				env: { [PARADIS_PROJECT_ROOT_ENV_VAR]: repositoryPath },
				onDidStart: () => {
					ranAny = true;
				},
			});
			ranAny = true;
		} catch (error) {
			// 後続プリセットを続行し、既に成功したプリセットの情報を呼び出し側へ返す。
			logService.warn(`[ParadisTerminalPresets] auto-run preset '${preset.name}' failed`, error);
		}
	}
	return ranAny;
}
