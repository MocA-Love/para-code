/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// レイアウトプリセットを組むキャンバス（EditorPane）。
//
// 枠そのものを画面に並べ、端にカーソルを合わせて分割していく。エディタエリアの分割操作と
// 同じ手触りにしてあり、組んでいる形がそのまま適用後の形になる。
// 形の計算は paradisLayoutTreeEdit.ts の純粋関数に任せ、ここは描画と入力の受け取りだけを持つ。

import './media/paradisLayoutPresets.css';
import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import {
	IParadisLayoutNode,
	IParadisLayoutSlot,
	ParadisLayoutOrientation,
	ParadisLayoutSlotKind,
	PARADIS_LAYOUT_MAX_SLOTS,
	PARADIS_LAYOUT_SLOT_KINDS,
	paradisCountLayoutSlots,
	paradisIsLayoutBranch,
} from '../common/paradisLayoutPresets.js';
import {
	ParadisLayoutPath,
	ParadisLayoutSplitDirection,
	PARADIS_LAYOUT_SPLIT_DIRECTIONS,
	PARADIS_LAYOUT_TEMPLATES,
	paradisOrientationAtDepth,
	paradisRemoveLayoutSlot,
	paradisSplitLayoutSlot,
	paradisUpdateLayoutSlot,
} from '../common/paradisLayoutTreeEdit.js';
import { paradisConfirmAndApplyLayoutPreset, paradisReportLayoutPresetFailure } from './paradisApplyLayoutPreset.js';
import { ParadisLayoutPresetEditorInput, PARADIS_LAYOUT_PRESET_EDITOR_ID } from './paradisLayoutPresetEditorInput.js';

const $ = dom.$;

/** 枠の種類ごとの見た目と入力欄。 */
interface ISlotKindPresentation {
	readonly label: string;
	readonly icon: ThemeIcon;
	/** 主となる入力欄（無い種類もある）。 */
	readonly field?: {
		readonly key: 'command' | 'url' | 'path';
		readonly label: string;
		readonly placeholder: string;
	};
	/** 副の入力欄（ターミナルの作業ディレクトリのみ）。 */
	readonly extraField?: {
		readonly key: 'cwd';
		readonly label: string;
		readonly placeholder: string;
	};
}

function slotKindPresentation(kind: ParadisLayoutSlotKind): ISlotKindPresentation {
	switch (kind) {
		case 'terminal':
			return {
				// allow-any-unicode-next-line
				label: localize('paradis.layoutPresets.kind.terminal', "ターミナル"),
				icon: Codicon.terminal,
				field: {
					key: 'command',
					// allow-any-unicode-next-line
					label: localize('paradis.layoutPresets.field.command', "コマンド"),
					// allow-any-unicode-next-line
					placeholder: localize('paradis.layoutPresets.field.commandPlaceholder', "空ならシェルを開くだけ"),
				},
				extraField: {
					key: 'cwd',
					// allow-any-unicode-next-line
					label: localize('paradis.layoutPresets.field.cwd', "作業ディレクトリ"),
					// allow-any-unicode-next-line
					placeholder: localize('paradis.layoutPresets.field.cwdPlaceholder', "空ならワークスペースのフォルダ"),
				},
			};
		case 'browser':
			return {
				// allow-any-unicode-next-line
				label: localize('paradis.layoutPresets.kind.browser', "ブラウザ"),
				icon: Codicon.globe,
				field: {
					key: 'url',
					label: localize('paradis.layoutPresets.field.url', "URL"),
					// allow-any-unicode-next-line
					placeholder: localize('paradis.layoutPresets.field.urlPlaceholder', "空なら空のタブ"),
				},
			};
		case 'file':
			return {
				// allow-any-unicode-next-line
				label: localize('paradis.layoutPresets.kind.file', "ファイル"),
				icon: Codicon.file,
				field: {
					key: 'path',
					// allow-any-unicode-next-line
					label: localize('paradis.layoutPresets.field.path', "パス"),
					// allow-any-unicode-next-line
					placeholder: localize('paradis.layoutPresets.field.pathPlaceholder', "ワークスペースからの相対パス"),
				},
			};
		default:
			return {
				// allow-any-unicode-next-line
				label: localize('paradis.layoutPresets.kind.empty', "未設定"),
				icon: Codicon.blank,
			};
	}
}

/** テンプレートの表示名。id と1対1で対応させる。 */
function templateLabel(id: string): string {
	switch (id) {
		// allow-any-unicode-next-line
		case 'single': return localize('paradis.layoutPresets.template.single', "1枠（分割なし）");
		// allow-any-unicode-next-line
		case 'columns2': return localize('paradis.layoutPresets.template.columns2', "左右2分割");
		// allow-any-unicode-next-line
		case 'rows2': return localize('paradis.layoutPresets.template.rows2', "上下2分割");
		// allow-any-unicode-next-line
		case 'grid4': return localize('paradis.layoutPresets.template.grid4', "2×2");
		// allow-any-unicode-next-line
		case 'left1right2': return localize('paradis.layoutPresets.template.left1right2', "左1・右上下2段");
		// allow-any-unicode-next-line
		default: return localize('paradis.layoutPresets.template.left2right1', "左上下2段・右1");
	}
}

const SPLIT_DIRECTION_TOOLTIP: Record<ParadisLayoutSplitDirection, string> = {
	// allow-any-unicode-next-line
	up: localize('paradis.layoutPresets.split.up', "この枠の上に枠を足す"),
	// allow-any-unicode-next-line
	down: localize('paradis.layoutPresets.split.down', "この枠の下に枠を足す"),
	// allow-any-unicode-next-line
	left: localize('paradis.layoutPresets.split.left', "この枠の左に枠を足す"),
	// allow-any-unicode-next-line
	right: localize('paradis.layoutPresets.split.right', "この枠の右に枠を足す"),
};

export class ParadisLayoutPresetEditor extends EditorPane {

	static readonly ID = PARADIS_LAYOUT_PRESET_EDITOR_ID;

	private root: HTMLElement | undefined;
	private canvas: HTMLElement | undefined;
	private nameInput: HTMLInputElement | undefined;
	private slotCountLabel: HTMLElement | undefined;
	/** キャンバスの描き直しで作った DOM リスナー。描くたびに捨てる。 */
	private readonly canvasDisposables = this._register(new DisposableStore());
	/** input の購読。setInput のたびに張り直す。 */
	private readonly inputDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(PARADIS_LAYOUT_PRESET_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	private get layoutInput(): ParadisLayoutPresetEditorInput | undefined {
		return this.input instanceof ParadisLayoutPresetEditorInput ? this.input : undefined;
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, $('.paradis-layout-preset-editor'));

		const toolbar = dom.append(this.root, $('.paradis-layout-toolbar'));

		// allow-any-unicode-next-line
		dom.append(toolbar, $('label.paradis-layout-toolbar-label')).textContent = localize('paradis.layoutPresets.nameLabel', "プリセット名");
		this.nameInput = dom.append(toolbar, $('input.paradis-layout-name')) as HTMLInputElement;
		this.nameInput.type = 'text';
		this._register(dom.addDisposableListener(this.nameInput, dom.EventType.INPUT, () => {
			const input = this.layoutInput;
			if (input) {
				input.updateDraft({ ...input.draft, name: this.nameInput!.value });
			}
		}));

		// allow-any-unicode-next-line
		dom.append(toolbar, $('label.paradis-layout-toolbar-label')).textContent = localize('paradis.layoutPresets.templateLabel', "テンプレート");
		const templateSelect = dom.append(toolbar, $('select.paradis-layout-select')) as HTMLSelectElement;
		const placeholder = dom.append(templateSelect, $('option')) as HTMLOptionElement;
		placeholder.value = '';
		// allow-any-unicode-next-line
		placeholder.textContent = localize('paradis.layoutPresets.templatePlaceholder', "形を選んで置き換え…");
		for (const template of PARADIS_LAYOUT_TEMPLATES) {
			const option = dom.append(templateSelect, $('option')) as HTMLOptionElement;
			option.value = template.id;
			option.textContent = templateLabel(template.id);
		}
		this._register(dom.addDisposableListener(templateSelect, dom.EventType.CHANGE, () => {
			const template = PARADIS_LAYOUT_TEMPLATES.find(candidate => candidate.id === templateSelect.value);
			templateSelect.value = '';
			const input = this.layoutInput;
			if (template && input) {
				// テンプレートは「形の置き換え」であって中身は触らない。既に入れた中身を
				// 消してしまわないよう、枠の数が足りる範囲で左上から順に引き継ぐ。
				input.updateDraft({ ...input.draft, orientation: template.orientation, root: this.carryOverSlots(template.root, input.draft.root) });
			}
		}));

		dom.append(toolbar, $('.paradis-layout-toolbar-spacer'));
		this.slotCountLabel = dom.append(toolbar, $('.paradis-layout-slot-count'));

		const applyButton = dom.append(toolbar, $('button.paradis-layout-button')) as HTMLButtonElement;
		// allow-any-unicode-next-line
		applyButton.textContent = localize('paradis.layoutPresets.applyNow', "このレイアウトを適用");
		this._register(dom.addDisposableListener(applyButton, dom.EventType.CLICK, () => {
			const input = this.layoutInput;
			if (input) {
				void paradisReportLayoutPresetFailure(this.notificationService, () =>
					this.instantiationService.invokeFunction(accessor => paradisConfirmAndApplyLayoutPreset(accessor, input.draft)));
			}
		}));

		const saveButton = dom.append(toolbar, $('button.paradis-layout-button.primary')) as HTMLButtonElement;
		saveButton.textContent = localize('paradis.layoutPresets.save', "保存");
		this._register(dom.addDisposableListener(saveButton, dom.EventType.CLICK, () => {
			const input = this.layoutInput;
			if (input) {
				void paradisReportLayoutPresetFailure(this.notificationService, () => input.save());
			}
		}));

		const hint = dom.append(this.root, $('.paradis-layout-hint'));
		hint.textContent = localize(
			'paradis.layoutPresets.hint',
			// allow-any-unicode-next-line
			"枠の端にカーソルを合わせると、その向きに枠を足せます。各枠のプルダウンで開くものを選び、右上の × で枠を減らします。",
		);

		this.canvas = dom.append(this.root, $('.paradis-layout-canvas'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputDisposables.clear();
		if (input instanceof ParadisLayoutPresetEditorInput) {
			// 下書きは input が持つので、差し替わるたびに描き直す（キャンバスは常に input の写し）。
			this.inputDisposables.add(input.onDidChangeDraft(() => this.render()));
		}
		this.render();
	}

	override clearInput(): void {
		this.inputDisposables.clear();
		this.canvasDisposables.clear();
		if (this.canvas) {
			dom.clearNode(this.canvas);
		}
		super.clearInput();
	}

	override layout(_dimension: dom.Dimension): void {
		// 枠は CSS の flex で伸縮するので、寸法に応じた再計算は要らない。
	}

	override focus(): void {
		super.focus();
		this.nameInput?.focus();
	}

	// --- 描画 ------------------------------------------------------------------------------------

	private render(): void {
		const input = this.layoutInput;
		if (!this.canvas || !this.nameInput || !input) {
			return;
		}
		const draft = input.draft;
		// 入力中のカーソル位置を飛ばさないよう、値が変わったときだけ書き戻す。
		if (this.nameInput.value !== draft.name) {
			this.nameInput.value = draft.name;
		}

		const slotCount = paradisCountLayoutSlots(draft.root);
		if (this.slotCountLabel) {
			this.slotCountLabel.textContent = slotCount >= PARADIS_LAYOUT_MAX_SLOTS
				// allow-any-unicode-next-line
				? localize('paradis.layoutPresets.slotCountMax', "{0}枠（これ以上は増やせません）", slotCount)
				// allow-any-unicode-next-line
				: localize('paradis.layoutPresets.slotCount', "{0}枠", slotCount);
		}

		this.canvasDisposables.clear();
		dom.clearNode(this.canvas);
		const orientation = draft.orientation ?? 'columns';
		this.canvas.appendChild(this.renderNodes(draft.root, [], orientation, 1, slotCount));
	}

	private renderNodes(
		nodes: readonly IParadisLayoutNode[],
		prefix: number[],
		rootOrientation: ParadisLayoutOrientation,
		depth: number,
		slotCount: number,
	): HTMLElement {
		const orientation = paradisOrientationAtDepth(rootOrientation, depth);
		const container = $('.paradis-layout-split');
		container.classList.add(orientation === 'columns' ? 'columns' : 'rows');
		nodes.forEach((node, index) => {
			const path = [...prefix, index];
			container.appendChild(paradisIsLayoutBranch(node)
				? this.renderNodes(node.children!, path, rootOrientation, depth + 1, slotCount)
				: this.renderPane(node, path, slotCount));
		});
		return container;
	}

	private renderPane(node: IParadisLayoutNode, path: ParadisLayoutPath, slotCount: number): HTMLElement {
		const slot: IParadisLayoutSlot = node.slot ?? { kind: 'empty' };
		const presentation = slotKindPresentation(slot.kind);
		const pane = $('.paradis-layout-pane');
		pane.classList.add(`kind-${slot.kind}`);

		const header = dom.append(pane, $('.paradis-layout-pane-header'));

		const kindSelect = dom.append(header, $('select.paradis-layout-pane-kind')) as HTMLSelectElement;
		for (const kind of PARADIS_LAYOUT_SLOT_KINDS) {
			const option = dom.append(kindSelect, $('option')) as HTMLOptionElement;
			option.value = kind;
			option.textContent = slotKindPresentation(kind).label;
		}
		kindSelect.value = slot.kind;
		this.canvasDisposables.add(dom.addDisposableListener(kindSelect, dom.EventType.CHANGE, () => {
			// 種類を変えたら中身の項目は引き継がない（URL 欄に残ったコマンドが、次に種類を
			// 戻したときに黙って復活するのを防ぐ）。
			this.mutate(root => paradisUpdateLayoutSlot(root, path, { kind: kindSelect.value as ParadisLayoutSlotKind }));
		}));

		if (presentation.field) {
			this.appendField(header, presentation.field.label, presentation.field.placeholder, slot[presentation.field.key] ?? '', value =>
				this.mutate(root => paradisUpdateLayoutSlot(root, path, { ...slot, [presentation.field!.key]: value })));
		}
		if (presentation.extraField) {
			this.appendField(header, presentation.extraField.label, presentation.extraField.placeholder, slot[presentation.extraField.key] ?? '', value =>
				this.mutate(root => paradisUpdateLayoutSlot(root, path, { ...slot, [presentation.extraField!.key]: value })));
		}

		if (slotCount > 1) {
			const remove = dom.append(header, $('button.paradis-layout-pane-remove')) as HTMLButtonElement;
			dom.append(remove, $(ThemeIcon.asCSSSelector(Codicon.close)));
			// allow-any-unicode-next-line
			remove.title = localize('paradis.layoutPresets.removePane', "この枠を削除");
			this.canvasDisposables.add(dom.addDisposableListener(remove, dom.EventType.CLICK, () =>
				this.mutate(root => paradisRemoveLayoutSlot(root, path))));
		}

		const body = dom.append(pane, $('.paradis-layout-pane-body'));
		dom.append(body, $(`.paradis-layout-pane-glyph${ThemeIcon.asCSSSelector(presentation.icon)}`));
		dom.append(body, $('.paradis-layout-pane-label')).textContent = presentation.label;
		const detail = presentation.field ? slot[presentation.field.key]?.trim() : undefined;
		if (detail) {
			dom.append(body, $('.paradis-layout-pane-detail')).textContent = detail;
		}

		if (slotCount < PARADIS_LAYOUT_MAX_SLOTS) {
			// 分割ゾーンは**本文領域の中だけ**に置く。枠全体に重ねると、透明でも当たり判定は
			// 生きているため、ヘッダーの種類プルダウンやコマンド入力欄を押したつもりで
			// 枠が増えてしまう。
			for (const direction of PARADIS_LAYOUT_SPLIT_DIRECTIONS) {
				const zone = dom.append(body, $('.paradis-layout-split-zone')) as HTMLElement;
				zone.classList.add(direction);
				zone.title = SPLIT_DIRECTION_TOOLTIP[direction];
				dom.append(zone, $(ThemeIcon.asCSSSelector(Codicon.add)));
				this.canvasDisposables.add(dom.addDisposableListener(zone, dom.EventType.CLICK, () => this.split(path, direction)));
			}
		}

		return pane;
	}

	private appendField(parent: HTMLElement, label: string, placeholder: string, value: string, onChange: (value: string) => void): void {
		const field = dom.append(parent, $('input.paradis-layout-pane-field')) as HTMLInputElement;
		field.type = 'text';
		field.placeholder = placeholder;
		field.value = value;
		field.title = label;
		field.setAttribute('aria-label', label);
		// change（フォーカスが外れたとき）で確定する。input ごとに木を作り直すと、そのたびに
		// キャンバス全体が描き直されて入力中のフォーカスが飛ぶ。
		this.canvasDisposables.add(dom.addDisposableListener(field, dom.EventType.CHANGE, () => onChange(field.value)));
	}

	// --- 編集操作 --------------------------------------------------------------------------------

	private mutate(update: (root: readonly IParadisLayoutNode[]) => readonly IParadisLayoutNode[]): void {
		const input = this.layoutInput;
		if (input) {
			input.updateDraft({ ...input.draft, root: update(input.draft.root) });
		}
	}

	private split(path: ParadisLayoutPath, direction: ParadisLayoutSplitDirection): void {
		const input = this.layoutInput;
		if (!input) {
			return;
		}
		const orientation = input.draft.orientation ?? 'columns';
		const result = paradisSplitLayoutSlot(input.draft.root, orientation, path, direction);
		// ルート直下が1枠だけのときの分割はルートの向き自体を変える（詳細は
		// paradisSplitLayoutSlot のコメント）。orientation も一緒に書き戻す。
		input.updateDraft({ ...input.draft, orientation: result.orientation, root: result.root });
	}

	/**
	 * テンプレートで形を置き換えるときに、既に入れた中身を左上から順に引き継ぐ。
	 * 新しい形の枠のほうが少ない場合、あふれた分の中身は落ちる。
	 */
	private carryOverSlots(template: readonly IParadisLayoutNode[], current: readonly IParadisLayoutNode[]): readonly IParadisLayoutNode[] {
		const slots: IParadisLayoutSlot[] = [];
		const collect = (list: readonly IParadisLayoutNode[]): void => {
			for (const node of list) {
				if (paradisIsLayoutBranch(node)) {
					collect(node.children!);
				} else if (node.slot && node.slot.kind !== 'empty') {
					slots.push(node.slot);
				}
			}
		};
		collect(current);

		let cursor = 0;
		const fill = (list: readonly IParadisLayoutNode[]): IParadisLayoutNode[] => list.map(node => paradisIsLayoutBranch(node)
			? { ...node, children: fill(node.children!) }
			: { ...node, slot: slots[cursor++] ?? { kind: 'empty' as const } });
		return fill(template);
	}
}
