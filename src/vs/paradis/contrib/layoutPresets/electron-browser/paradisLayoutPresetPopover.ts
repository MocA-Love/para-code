/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタタイトル（タブバー右側）のボタンから開く、レイアウトプリセットの一覧ポップオーバー。
//
// コンテキストメニューではなく自前のポップオーバーにしているのは、**形のサムネイルを見せる**ため。
// レイアウトは名前を読むより形を見たほうが速く選べるうえ、同じ名前を複数付けられる仕様なので、
// 文字だけの一覧では押す前に区別が付かないことがある。

import './media/paradisLayoutPresets.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { ActionViewItem, IActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IContextViewService, IOpenContextView } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import {
	IParadisLayoutNode,
	IParadisLayoutPresetService,
	IParadisResolvedLayoutPreset,
	ParadisLayoutSlotKind,
	paradisIsLayoutBranch,
	paradisLayoutPresetSummary,
} from '../common/paradisLayoutPresets.js';
import { paradisOrientationAtDepth } from '../common/paradisLayoutTreeEdit.js';
import { paradisConfirmAndApplyLayoutPreset, paradisReportLayoutPresetFailure } from './paradisApplyLayoutPreset.js';
import { ParadisLayoutPresetEditorInput } from './paradisLayoutPresetEditorInput.js';

const $ = dom.$;

/** 枠の種類の表示名。サムネイルの下の要約に使う。 */
function slotKindLabels(): Record<ParadisLayoutSlotKind, string> {
	return {
		// allow-any-unicode-next-line
		empty: localize('paradis.layoutPresets.popover.kind.empty', "未設定"),
		// allow-any-unicode-next-line
		terminal: localize('paradis.layoutPresets.popover.kind.terminal', "ターミナル"),
		// allow-any-unicode-next-line
		browser: localize('paradis.layoutPresets.popover.kind.browser', "ブラウザ"),
		// allow-any-unicode-next-line
		file: localize('paradis.layoutPresets.popover.kind.file', "ファイル"),
	};
}

/**
 * 形のサムネイル。木をそのまま入れ子の flex で縮めて描く。
 * `size` があれば `flex-grow` に載せるので、比率を指定したプリセットは一覧でもその比率で見える。
 */
function renderThumbnail(preset: IParadisResolvedLayoutPreset): HTMLElement {
	const rootOrientation = preset.orientation ?? 'columns';
	const build = (nodes: readonly IParadisLayoutNode[], depth: number): HTMLElement => {
		const orientation = paradisOrientationAtDepth(rootOrientation, depth);
		const split = $('.paradis-layout-thumb-split');
		split.classList.add(orientation === 'columns' ? 'columns' : 'rows');
		for (const node of nodes) {
			const child = paradisIsLayoutBranch(node)
				? build(node.children!, depth + 1)
				: $(`.paradis-layout-thumb-slot.kind-${node.slot?.kind ?? 'empty'}`);
			if (node.size !== undefined) {
				child.style.flexGrow = String(node.size);
			}
			split.appendChild(child);
		}
		return split;
	};
	const thumb = $('.paradis-layout-thumb');
	thumb.appendChild(build(preset.root, 1));
	return thumb;
}

/**
 * プリセット一覧のポップオーバーを開く。
 * @param anchor 開いたボタン。ここへのクリックは「外側」に数えない（トグルとして働かせるため）。
 */
export function showParadisLayoutPresetPopover(accessor: ServicesAccessor, anchor: HTMLElement): IOpenContextView {
	const contextViewService = accessor.get(IContextViewService);
	const presetService = accessor.get(IParadisLayoutPresetService);
	const instantiationService = accessor.get(IInstantiationService);
	const editorService = accessor.get(IEditorService);
	const dialogService = accessor.get(IDialogService);
	const notificationService = accessor.get(INotificationService);

	const labels = slotKindLabels();

	return contextViewService.showContextView({
		getAnchor: () => anchor,
		anchorAlignment: AnchorAlignment.RIGHT,
		anchorPosition: AnchorPosition.BELOW,
		render: (container: HTMLElement): IDisposable => {
			const disposables = new DisposableStore();
			const popover = dom.append(container, $('.paradis-layout-popover'));

			// allow-any-unicode-next-line
			dom.append(popover, $('.paradis-layout-popover-title')).textContent = localize('paradis.layoutPresets.popover.title', "レイアウトプリセットを適用");

			const list = dom.append(popover, $('.paradis-layout-popover-list'));
			const presets = presetService.presets;
			if (presets.length === 0) {
				dom.append(list, $('.paradis-layout-popover-empty')).textContent = localize(
					'paradis.layoutPresets.popover.empty',
					// allow-any-unicode-next-line
					"レイアウトプリセットがまだありません。下のボタンから、エディタエリアの枠の組み方を作れます。",
				);
			}

			const openEditor = (presetKey: string | undefined): void => {
				contextViewService.hideContextView();
				const input = instantiationService.createInstance(ParadisLayoutPresetEditorInput, presetKey);
				void editorService.openEditor(input, { pinned: true });
			};

			let firstItem: HTMLElement | undefined;
			for (const preset of presets) {
				// 行は button ではなく role="button" の div にする。button の中に button（編集・削除）を
				// 入れるのは不正なネストで、内側を押した Enter が外側の既定動作（＝適用）まで
				// 引いてしまう——キーボードだけ操作が逆になる、という気づきにくい壊れ方をする。
				const item = dom.append(list, $('.paradis-layout-popover-item'));
				item.setAttribute('role', 'button');
				item.tabIndex = 0;
				firstItem ??= item;
				item.title = preset.description ?? preset.name;
				item.appendChild(renderThumbnail(preset));

				const main = dom.append(item, $('.paradis-layout-popover-main'));
				dom.append(main, $('.paradis-layout-popover-name')).textContent = preset.name;
				dom.append(main, $('.paradis-layout-popover-summary')).textContent = paradisLayoutPresetSummary(preset, labels);

				const actions = dom.append(item, $('.paradis-layout-popover-actions'));

				const edit = dom.append(actions, $('button.paradis-layout-popover-action')) as HTMLButtonElement;
				// allow-any-unicode-next-line
				edit.title = localize('paradis.layoutPresets.popover.edit', "編集");
				dom.append(edit, $(ThemeIcon.asCSSSelector(Codicon.edit)));
				disposables.add(dom.addDisposableListener(edit, dom.EventType.CLICK, e => {
					dom.EventHelper.stop(e, true);
					openEditor(preset.key);
				}));

				const remove = dom.append(actions, $('button.paradis-layout-popover-action')) as HTMLButtonElement;
				// allow-any-unicode-next-line
				remove.title = localize('paradis.layoutPresets.popover.delete', "削除");
				dom.append(remove, $(ThemeIcon.asCSSSelector(Codicon.trash)));
				disposables.add(dom.addDisposableListener(remove, dom.EventType.CLICK, async e => {
					dom.EventHelper.stop(e, true);
					contextViewService.hideContextView();
					const { confirmed } = await dialogService.confirm({
						// allow-any-unicode-next-line
						message: localize('paradis.layoutPresets.popover.deleteConfirm', "レイアウト「{0}」を削除しますか？", preset.name),
						// allow-any-unicode-next-line
						primaryButton: localize('paradis.layoutPresets.popover.deleteConfirmYes', "削除"),
						type: 'warning',
					});
					if (confirmed) {
						await paradisReportLayoutPresetFailure(notificationService, () => presetService.deletePreset(preset));
					}
				}));

				// 行そのものを押したら適用する（一覧の主目的は「選んで適用」なので、
				// 編集や削除は上のアイコンに寄せて、行の既定の動作を1つに保つ）。
				const apply = (): void => {
					contextViewService.hideContextView();
					void paradisReportLayoutPresetFailure(notificationService, () =>
						instantiationService.invokeFunction(accessor2 => paradisConfirmAndApplyLayoutPreset(accessor2, preset)));
				};
				disposables.add(dom.addDisposableListener(item, dom.EventType.CLICK, apply));
				// role="button" の div は Enter / Space を自前で拾う必要がある。
				disposables.add(dom.addDisposableListener(item, dom.EventType.KEY_DOWN, e => {
					const event = new StandardKeyboardEvent(e);
					if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
						dom.EventHelper.stop(e, true);
						apply();
					}
				}));
			}

			const footer = dom.append(popover, $('.paradis-layout-popover-footer'));
			const create = dom.append(footer, $('button.paradis-layout-button')) as HTMLButtonElement;
			// allow-any-unicode-next-line
			create.textContent = localize('paradis.layoutPresets.popover.create', "新しいレイアウトを作成");
			disposables.add(dom.addDisposableListener(create, dom.EventType.CLICK, () => openEditor(undefined)));

			disposables.add(dom.addDisposableListener(popover, dom.EventType.KEY_DOWN, e => {
				if (new StandardKeyboardEvent(e).equals(KeyCode.Escape)) {
					dom.EventHelper.stop(e, true);
					contextViewService.hideContextView();
					anchor.focus();
				}
			}));

			(firstItem ?? create).focus();
			return disposables;
		},
		onDOMEvent: (event: { readonly target?: EventTarget | null }) => {
			// 既定の実装は「ワークベンチ全体の外」でしか閉じない＝実質閉じないので、自分で閉じる。
			//
			// **イベントの種類で振り分けてはいけない。** ここへ来る click / keydown は
			// dom.addStandardDisposableListener によって StandardMouseEvent / StandardKeyboardEvent に
			// 包まれており、**どちらも `type` を持たない**。`e.type === 'click'` のような条件を書くと
			// 常に undefined と比較することになり、条件が一度も成立せずポップオーバーが閉じなくなる。
			// 見てよいのは `target` だけ（包まれた側にもある）。
			const target = event.target;
			if (!dom.isHTMLElement(target)) {
				return;
			}
			const view = contextViewService.getContextViewElement();
			if (!dom.isAncestor(target, view) && !dom.isAncestor(target, anchor)) {
				contextViewService.hideContextView();
			}
		},
	});
}

/**
 * タブバーのボタン本体。押すとポップオーバーを開く。
 *
 * upstream の {@link MenuEntryActionViewItem} ではなく base の {@link ActionViewItem} を継承して
 * いるのは、あちらは注入するサービスが多く、継承するとそのコンストラクタ引数の並びに縛られて
 * upstream 取り込みのたびに壊れるため。アイコンは `MenuItemAction.class` に入っているので、
 * `icon: true` を渡すだけで素の ActionViewItem でも描ける。
 */
export class ParadisLayoutPresetToolbarItem extends ActionViewItem {

	/** 自分が開いたポップオーバー。ボタンが消えるときに道連れにする。 */
	private opened: IOpenContextView | undefined;

	constructor(
		action: IAction,
		options: IActionViewItemOptions | undefined,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(undefined, action, { ...options, icon: true, label: false });
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('paradis-layout-preset-toolbar-item');
	}

	override async onClick(event: MouseEvent): Promise<void> {
		dom.EventHelper.stop(event, true);
		const anchor = this.element;
		if (!anchor) {
			return;
		}
		if (this.opened) {
			// 開いているときに押したら閉じる（トグル）。ポップオーバー側の外側クリック判定は
			// このボタンを「外」に数えないので、ここで閉じないと押しても何も起きない。
			this.close();
			return;
		}
		this.opened = this.instantiationService.invokeFunction(accessor => showParadisLayoutPresetPopover(accessor, anchor));
	}

	private close(): void {
		this.opened?.close();
		this.opened = undefined;
	}

	override dispose(): void {
		// ツールバーはエディタグループの増減で作り直される（レイアウトの適用がまさにそれ）。
		// 開いたままだと、消えたボタンに紐づいたポップオーバーだけが画面に residue として残る。
		this.close();
		super.dispose();
	}
}
