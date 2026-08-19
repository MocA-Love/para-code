/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// レイアウトプリセット機能の登録入り口。paradis.electron-browser.contribution.ts から import される。
//   - 設定スキーマ（paradis.editor.layoutPresets）
//   - IParadisLayoutPresetService の登録
//   - 編集キャンバス（EditorPane）とタブ復元のシリアライザ
//   - エディタタイトル（タブバー右側）のボタン＝プリセット一覧ポップオーバーの入り口
//   - コマンドパレット（適用 / 新規作成）

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import {
	IParadisLayoutPresetService,
	IParadisResolvedLayoutPreset,
	PARADIS_LAYOUT_MAX_SLOTS,
	PARADIS_LAYOUT_ORIENTATIONS,
	PARADIS_LAYOUT_PRESETS_SETTING,
	PARADIS_LAYOUT_SLOT_KINDS,
	paradisLayoutPresetSummary,
} from '../common/paradisLayoutPresets.js';
import { paradisConfirmAndApplyLayoutPreset } from './paradisApplyLayoutPreset.js';
import { ParadisLayoutPresetEditor } from './paradisLayoutPresetEditor.js';
import {
	ParadisLayoutPresetEditorInput,
	ParadisLayoutPresetEditorInputSerializer,
	PARADIS_LAYOUT_PRESET_EDITOR_ID,
	PARADIS_LAYOUT_PRESET_INPUT_TYPE_ID,
} from './paradisLayoutPresetEditorInput.js';
import { ParadisLayoutPresetService } from './paradisLayoutPresetService.js';
import { ParadisLayoutPresetToolbarItem } from './paradisLayoutPresetPopover.js';

registerSingleton(IParadisLayoutPresetService, ParadisLayoutPresetService, InstantiationType.Delayed);

const CATEGORY = localize2('paradis.category', "Para Code");
const SHOW_PRESETS_COMMAND_ID = 'paradis.editor.showLayoutPresets';
const APPLY_PRESET_COMMAND_ID = 'paradis.editor.applyLayoutPreset';
const CREATE_PRESET_COMMAND_ID = 'paradis.editor.createLayoutPreset';

// --- 設定スキーマ --------------------------------------------------------------------------------

/** 枠の木は入れ子なので、スキーマも $ref で自分自身を参照させる。 */
const LAYOUT_NODE_SCHEMA_ID = '#/definitions/paradisLayoutNode';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradisLayoutPresets',
	order: 999,
	title: localize('paradis.layoutPresets.configTitle', "Layout Presets (Para Code)"),
	type: 'object',
	properties: {
		[PARADIS_LAYOUT_PRESETS_SETTING]: {
			type: 'array',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize(
				'paradis.editor.layoutPresets',
				// allow-any-unicode-next-line
				"エディタエリアのレイアウトプリセット。枠の組み方と、各枠に開くもの（ターミナル・内蔵ブラウザ・ファイル）を持ちます。タブバー右側の「レイアウトプリセット」ボタンから GUI で作成・適用できます。1つのプリセットに置ける枠は最大 {0} 個です。",
				PARADIS_LAYOUT_MAX_SLOTS,
			),
			items: {
				type: 'object',
				required: ['name', 'root'],
				properties: {
					// allow-any-unicode-next-line
					id: { type: 'string', description: localize('paradis.layoutPresets.schema.id', "識別子。GUI で保存すると自動で入ります（手で書く必要はありません）。名前は識別子ではないため、同じ名前のプリセットを複数登録できます。") },
					// allow-any-unicode-next-line
					name: { type: 'string', description: localize('paradis.layoutPresets.schema.name', "プリセット名。") },
					// allow-any-unicode-next-line
					description: { type: 'string', description: localize('paradis.layoutPresets.schema.description', "説明（ツールチップに表示）。") },
					// allow-any-unicode-next-line
					icon: { type: 'string', description: localize('paradis.layoutPresets.schema.icon', "一覧に出す codicon 名（例: layout）。") },
					orientation: {
						type: 'string',
						enum: [...PARADIS_LAYOUT_ORIENTATIONS],
						enumDescriptions: [
							// allow-any-unicode-next-line
							localize('paradis.layoutPresets.schema.orientation.columns', "ルート直下の枠を左右に並べる"),
							// allow-any-unicode-next-line
							localize('paradis.layoutPresets.schema.orientation.rows', "ルート直下の枠を上下に並べる"),
						],
						// allow-any-unicode-next-line
						description: localize('paradis.layoutPresets.schema.orientation', "ルート直下の並べ方。入れ子の枠は常に親と直交する向きに並びます。既定は columns。"),
					},
					root: {
						type: 'array',
						// allow-any-unicode-next-line
						description: localize('paradis.layoutPresets.schema.root', "枠の木。children を持つノードは分岐（子は親と直交する向きに並ぶ）、持たないノードは1つの枠。"),
						items: { $ref: LAYOUT_NODE_SCHEMA_ID },
					},
				},
			},
			definitions: {
				paradisLayoutNode: {
					type: 'object',
					properties: {
						// allow-any-unicode-next-line
						size: { type: 'number', description: localize('paradis.layoutPresets.schema.size', "同じ行／列の中での比率（相対値）。同じ親の子の合計が全体になるよう正規化されるので、0.3/0.7 でも 3/7 でも同じ結果になります。") },
						children: {
							type: 'array',
							// allow-any-unicode-next-line
							description: localize('paradis.layoutPresets.schema.children', "この枠を分岐にして、親と直交する向きに並べる子。"),
							items: { $ref: LAYOUT_NODE_SCHEMA_ID },
						},
						slot: {
							type: 'object',
							// allow-any-unicode-next-line
							description: localize('paradis.layoutPresets.schema.slot', "この枠に開くもの。children があるときは無視されます。"),
							properties: {
								kind: {
									type: 'string',
									enum: [...PARADIS_LAYOUT_SLOT_KINDS],
									enumDescriptions: [
										// allow-any-unicode-next-line
										localize('paradis.layoutPresets.schema.kind.empty', "何も開かない（枠だけ作る）"),
										// allow-any-unicode-next-line
										localize('paradis.layoutPresets.schema.kind.terminal', "ターミナルを開く"),
										// allow-any-unicode-next-line
										localize('paradis.layoutPresets.schema.kind.browser', "内蔵ブラウザのタブを開く"),
										// allow-any-unicode-next-line
										localize('paradis.layoutPresets.schema.kind.file', "ファイルを開く"),
									],
									// allow-any-unicode-next-line
									description: localize('paradis.layoutPresets.schema.kind', "この枠に開くものの種類。"),
								},
								// allow-any-unicode-next-line
								command: { type: 'string', description: localize('paradis.layoutPresets.schema.command', "ターミナル: 起動直後に送るコマンド。") },
								// allow-any-unicode-next-line
								cwd: { type: 'string', description: localize('paradis.layoutPresets.schema.cwd', "ターミナル: 作業ディレクトリ。相対パスはワークスペースの**先頭**フォルダ基準（複数フォルダを開いている場合も先頭が基準）。") },
								// allow-any-unicode-next-line
								name: { type: 'string', description: localize('paradis.layoutPresets.schema.slotName', "ターミナル: タブのタイトル。未指定はプリセット名。") },
								// allow-any-unicode-next-line
								url: { type: 'string', description: localize('paradis.layoutPresets.schema.url', "ブラウザ: 開く URL。") },
								// allow-any-unicode-next-line
								path: { type: 'string', description: localize('paradis.layoutPresets.schema.path', "ファイル: 開くファイル。可搬性のため、ワークスペースの**先頭**フォルダからの相対パスを推奨。") },
							},
						},
					},
				},
			},
			default: [],
		},
	},
});

// --- 編集キャンバス ------------------------------------------------------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ParadisLayoutPresetEditor,
		PARADIS_LAYOUT_PRESET_EDITOR_ID,
		// allow-any-unicode-next-line
		localize('paradis.layoutPresets.editorName', "レイアウトプリセット"),
	),
	[
		new SyncDescriptor(ParadisLayoutPresetEditorInput),
	],
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_LAYOUT_PRESET_INPUT_TYPE_ID,
	ParadisLayoutPresetEditorInputSerializer,
);

// --- タブバーのボタン ----------------------------------------------------------------------------

/**
 * タブバー右側にプリセット一覧のボタンを常設する。
 * ボタン自体は素のコマンドとして登録し、押したときの挙動（ポップオーバー）は
 * {@link ParadisLayoutPresetToolbarItem} が受け持つ。こうしておくと、キーバインドや
 * コマンドパレットからは素直に一覧が開き、ツールバーからは位置に吸い付いたポップオーバーが開く。
 */
class ParadisLayoutPresetButtonContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisLayoutPresetButton';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
	) {
		super();
		for (const menuId of [MenuId.EditorTitle, MenuId.CompactWindowEditorTitle]) {
			this._register(MenuRegistry.appendMenuItem(menuId, {
				command: {
					id: SHOW_PRESETS_COMMAND_ID,
					// allow-any-unicode-next-line
					title: localize2('paradis.layoutPresets.showButton', "レイアウトプリセット"),
					icon: Codicon.layout,
				},
				group: 'navigation',
				// コマンドプリセットのドロップダウン(99)と管理ボタン(100)の左に置く
				order: 98,
				when: IsSessionsWindowContext.toNegated(),
			}));
			this._register(actionViewItemService.register(menuId, SHOW_PRESETS_COMMAND_ID, (action, options, instantiationService) =>
				instantiationService.createInstance(ParadisLayoutPresetToolbarItem, action, options)));
		}
	}
}

registerWorkbenchContribution2(ParadisLayoutPresetButtonContribution.ID, ParadisLayoutPresetButtonContribution, WorkbenchPhase.AfterRestored);

// --- コマンド ------------------------------------------------------------------------------------

interface ILayoutPresetQuickPickItem extends IQuickPickItem {
	readonly preset: IParadisResolvedLayoutPreset;
}

/**
 * ツールバー以外（キーバインド・コマンドパレット）から呼ばれたときの一覧。
 * ポップオーバーは押したボタンに吸い付く作りなので、位置の手がかりが無いこの経路では
 * 素直にクイックピックを出す。
 */
registerAction2(class ShowLayoutPresetsAction extends Action2 {
	constructor() {
		super({
			id: SHOW_PRESETS_COMMAND_ID,
			// allow-any-unicode-next-line
			// watermark・タブバーのボタンと表示名を揃える(以前は英語のままで経路によって名前が食い違っていた)
			title: localize2('paradis.layoutPresets.show', "レイアウトプリセットを適用..."),
			category: CATEGORY,
			f1: true,
			// watermark はキーバインドの無いコマンドを表示しないため必須。
			// ⌃⌘T (toggleEditorTerminal) に揃えて ⌃⌘L を使う
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyL,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyL }
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const presetService = accessor.get(IParadisLayoutPresetService);
		const quickInputService = accessor.get(IQuickInputService);
		const instantiationService = accessor.get(IInstantiationService);
		const editorService = accessor.get(IEditorService);

		const presets = presetService.presets;
		if (presets.length === 0) {
			const { confirmed } = await accessor.get(IDialogService).confirm({
				// allow-any-unicode-next-line
				message: localize('paradis.layoutPresets.noPresets', "レイアウトプリセットがまだありません。"),
				// allow-any-unicode-next-line
				detail: localize('paradis.layoutPresets.noPresetsDetail', "エディタエリアの枠の組み方を作りますか？"),
				// allow-any-unicode-next-line
				primaryButton: localize('paradis.layoutPresets.noPresetsCreate', "作成"),
			});
			if (confirmed) {
				await editorService.openEditor(instantiationService.createInstance(ParadisLayoutPresetEditorInput, undefined), { pinned: true });
			}
			return;
		}

		const labels = {
			// allow-any-unicode-next-line
			empty: localize('paradis.layoutPresets.pick.kind.empty', "未設定"),
			// allow-any-unicode-next-line
			terminal: localize('paradis.layoutPresets.pick.kind.terminal', "ターミナル"),
			// allow-any-unicode-next-line
			browser: localize('paradis.layoutPresets.pick.kind.browser', "ブラウザ"),
			// allow-any-unicode-next-line
			file: localize('paradis.layoutPresets.pick.kind.file', "ファイル"),
		};
		const picks: ILayoutPresetQuickPickItem[] = presets.map(preset => ({
			preset,
			label: preset.name,
			description: preset.description,
			detail: paradisLayoutPresetSummary(preset, labels),
		}));
		const pick = await quickInputService.pick(picks, {
			// allow-any-unicode-next-line
			placeHolder: localize('paradis.layoutPresets.pickPlaceholder', "適用するレイアウトプリセットを選択"),
		});
		if (pick) {
			await instantiationService.invokeFunction(inner => paradisConfirmAndApplyLayoutPreset(inner, pick.preset));
		}
	}
});

/** キーバインドから特定のプリセットを直接適用するための引数付きコマンド。 */
registerAction2(class ApplyLayoutPresetAction extends Action2 {
	constructor() {
		super({
			id: APPLY_PRESET_COMMAND_ID,
			title: localize2('paradis.layoutPresets.apply', "Apply Editor Layout Preset by Name"),
			category: CATEGORY,
			// 名前を引数で渡す必要があるので、コマンドパレットには出さない（上の一覧から選ぶ）。
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, nameOrKey?: string): Promise<void> {
		if (typeof nameOrKey !== 'string') {
			return;
		}
		const presets = accessor.get(IParadisLayoutPresetService).presets;
		const preset = presets.find(candidate => candidate.key === nameOrKey) ?? presets.find(candidate => candidate.name === nameOrKey);
		if (preset) {
			await accessor.get(IInstantiationService).invokeFunction(inner => paradisConfirmAndApplyLayoutPreset(inner, preset));
		}
	}
});

registerAction2(class CreateLayoutPresetAction extends Action2 {
	constructor() {
		super({
			id: CREATE_PRESET_COMMAND_ID,
			title: localize2('paradis.layoutPresets.create', "Create Editor Layout Preset..."),
			category: CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const input = accessor.get(IInstantiationService).createInstance(ParadisLayoutPresetEditorInput, undefined);
		await accessor.get(IEditorService).openEditor(input, { pinned: true });
	}
});
