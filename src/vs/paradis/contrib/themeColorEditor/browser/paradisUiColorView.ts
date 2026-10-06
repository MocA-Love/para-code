/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// テーマの色エディタの「UI の色」タブ。左に色 ID の一覧（検索・絞り込み・グループ）、右に選んだ色の
// カラーピッカーと、テーマの色 / Para Code の既定 / 自分で変えた色のどれが効いているかを出す。

import * as dom from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Color } from '../../../../base/common/color.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ColorContribution, getColorRegistry } from '../../../../platform/theme/common/colorRegistry.js';
import { IWorkbenchThemeService } from '../../../../workbench/services/themes/common/workbenchThemeService.js';
import {
	IParadisColorLayers,
	IParadisColorOrigin,
	paradisApplyColorEdits,
	paradisFilterColorEntries,
	paradisGroupColorEntries,
	paradisExactScopeShadowed,
	paradisPlanRevertToParaDefault,
	paradisPlanRevertToTheme,
	paradisReadLayerColor,
	paradisResolveColorOrigin,
	paradisThemeScopeKey,
	PARADIS_COLOR_CUSTOMIZATIONS_KEY,
	PARADIS_DEFAULT_COLOR_VALUE,
} from '../common/paradisThemeColorModel.js';
import { ParadisColorPickerWidget } from './paradisColorPickerWidget.js';
import { IParadisThemeColorDraftService } from './paradisThemeColorDraftService.js';
import { paradisCreateButton, paradisCreateChip, paradisRenderLayerRows, paradisSetSwatch } from './paradisThemeColorViewParts.js';

const $ = dom.$;

type Filter = 'all' | 'modified' | 'paraDefault';

/** よく出てくるグループの日本語名（無いものは ID の前半をそのまま出す）。検索はこの名前でも当たる。 */
function groupLabel(group: string): string {
	switch (group) {
		case 'activityBar': return localize('paradis.themeColors.group.activityBar', "アクティビティバー");
		case 'activityBarBadge': return localize('paradis.themeColors.group.activityBarBadge', "アクティビティバーのバッジ");
		case 'statusBar': return localize('paradis.themeColors.group.statusBar', "ステータスバー");
		case 'statusBarItem': return localize('paradis.themeColors.group.statusBarItem', "ステータスバーの項目");
		case 'tab': return localize('paradis.themeColors.group.tab', "タブ");
		case 'editor': return localize('paradis.themeColors.group.editor', "エディター");
		case 'editorGroup': return localize('paradis.themeColors.group.editorGroup', "エディターグループ");
		case 'editorGroupHeader': return localize('paradis.themeColors.group.editorGroupHeader', "エディターグループの見出し");
		case 'editorGutter': return localize('paradis.themeColors.group.editorGutter', "エディターの余白");
		case 'editorLineNumber': return localize('paradis.themeColors.group.editorLineNumber', "行番号");
		case 'editorCursor': return localize('paradis.themeColors.group.editorCursor', "カーソル");
		case 'editorWidget': return localize('paradis.themeColors.group.editorWidget', "エディターのウィジェット");
		case 'editorSuggestWidget': return localize('paradis.themeColors.group.editorSuggestWidget', "候補の一覧");
		case 'editorHoverWidget': return localize('paradis.themeColors.group.editorHoverWidget', "ホバー");
		case 'editorOverviewRuler': return localize('paradis.themeColors.group.editorOverviewRuler', "概要ルーラー");
		case 'editorError': return localize('paradis.themeColors.group.editorError', "エラー");
		case 'editorWarning': return localize('paradis.themeColors.group.editorWarning', "警告");
		case 'sideBar': return localize('paradis.themeColors.group.sideBar', "サイドバー");
		case 'sideBarSectionHeader': return localize('paradis.themeColors.group.sideBarSectionHeader', "サイドバーの区切り見出し");
		case 'sideBarTitle': return localize('paradis.themeColors.group.sideBarTitle', "サイドバーの見出し");
		case 'panel': return localize('paradis.themeColors.group.panel', "パネル");
		case 'panelTitle': return localize('paradis.themeColors.group.panelTitle', "パネルの見出し");
		case 'terminal': return localize('paradis.themeColors.group.terminal', "ターミナル");
		case 'terminalCursor': return localize('paradis.themeColors.group.terminalCursor', "ターミナルのカーソル");
		case 'list': return localize('paradis.themeColors.group.list', "一覧とツリー");
		case 'tree': return localize('paradis.themeColors.group.tree', "ツリー");
		case 'button': return localize('paradis.themeColors.group.button', "ボタン");
		case 'input': return localize('paradis.themeColors.group.input', "入力欄");
		case 'inputOption': return localize('paradis.themeColors.group.inputOption', "入力欄の切り替え");
		case 'inputValidation': return localize('paradis.themeColors.group.inputValidation', "入力の検証");
		case 'dropdown': return localize('paradis.themeColors.group.dropdown', "ドロップダウン");
		case 'checkbox': return localize('paradis.themeColors.group.checkbox', "チェックボックス");
		case 'badge': return localize('paradis.themeColors.group.badge', "バッジ");
		case 'scrollbar': return localize('paradis.themeColors.group.scrollbar', "スクロールバー");
		case 'scrollbarSlider': return localize('paradis.themeColors.group.scrollbarSlider', "スクロールバーのつまみ");
		case 'titleBar': return localize('paradis.themeColors.group.titleBar', "タイトルバー");
		case 'menu': return localize('paradis.themeColors.group.menu', "メニュー");
		case 'menubar': return localize('paradis.themeColors.group.menubar', "メニューバー");
		case 'notifications': return localize('paradis.themeColors.group.notifications', "通知");
		case 'notificationCenterHeader': return localize('paradis.themeColors.group.notificationCenterHeader', "通知センターの見出し");
		case 'quickInput': return localize('paradis.themeColors.group.quickInput', "クイック入力");
		case 'quickInputList': return localize('paradis.themeColors.group.quickInputList', "クイック入力の一覧");
		case 'diffEditor': return localize('paradis.themeColors.group.diffEditor', "差分エディター");
		case 'minimap': return localize('paradis.themeColors.group.minimap', "ミニマップ");
		case 'gitDecoration': return localize('paradis.themeColors.group.gitDecoration', "Git の色分け");
		case 'breadcrumb': return localize('paradis.themeColors.group.breadcrumb', "パンくず");
		case 'textLink': return localize('paradis.themeColors.group.textLink', "リンク");
		case 'progressBar': return localize('paradis.themeColors.group.progressBar', "進み具合のバー");
		case 'widget': return localize('paradis.themeColors.group.widget', "ウィジェット");
		case 'debugToolBar': return localize('paradis.themeColors.group.debugToolBar', "デバッグのツールバー");
		case 'chat': return localize('paradis.themeColors.group.chat', "チャット");
		case 'focusBorder': return localize('paradis.themeColors.group.focusBorder', "フォーカスの枠");
		case 'foreground': return localize('paradis.themeColors.group.foreground', "文字（全体）");
		case 'charts': return localize('paradis.themeColors.group.charts', "グラフ");
		default: return group;
	}
}

interface IColorState {
	readonly origin: IParadisColorOrigin;
	readonly userValue: string | undefined;
	readonly paraValue: string | undefined;
	readonly workspaceValue: string | undefined;
	readonly hasDraft: boolean;
}

export interface IParadisUiColorViewDelegate {
	startScreenPick(): void;
}

export class ParadisUiColorView extends Disposable {

	readonly element: HTMLElement;

	private readonly searchInput: HTMLInputElement;
	private readonly chips = new Map<Filter, HTMLButtonElement>();
	private readonly items: HTMLElement;
	private readonly rowSwatches = new Map<string, HTMLElement>();
	private readonly rowElements = new Map<string, HTMLElement>();
	private readonly rowBadges = new Map<string, HTMLElement>();
	/** 行ごとに最後に描いたバッジと色見本（変わった行だけ DOM を書き換えるため）。 */
	private readonly badgeKeys = new Map<string, string>();
	private readonly swatchValues = new Map<string, string | undefined>();
	/** 前回描いたときに下書きがあった色（下書きが消えた行のバッジも描き直すため）。 */
	private lastDraftIds = new Set<string>();
	private readonly listStore = this._register(new MutableDisposable<DisposableStore>());

	private readonly detail: HTMLElement;
	private readonly detailEmpty: HTMLElement;
	private readonly detailBody: HTMLElement;
	private readonly detailId: HTMLElement;
	private readonly detailDescription: HTMLElement;
	private readonly detailWarning: HTMLElement;
	private readonly picker: ParadisColorPickerWidget;
	private readonly layers: HTMLElement;
	private readonly saveTarget: HTMLElement;
	private readonly revertParaButton: Button;
	private readonly revertThemeButton: Button;
	private readonly undoButton: Button;

	private filter: Filter = 'all';
	private selectedId: string | undefined;
	private readonly searchScheduler = this._register(new RunOnceScheduler(() => this.renderList(), 120));

	constructor(
		container: HTMLElement,
		private readonly delegate: IParadisUiColorViewDelegate,
		@IParadisThemeColorDraftService private readonly draftService: IParadisThemeColorDraftService,
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this.element = dom.append(container, $('.paradis-tce-view.paradis-tce-ui'));
		const store = this._register(new DisposableStore());

		// --- 左: 一覧 ---
		const list = dom.append(this.element, $('.paradis-tce-list'));
		const searchRow = dom.append(list, $('.paradis-tce-search-row'));
		this.searchInput = dom.append(searchRow, $<HTMLInputElement>('input.paradis-tce-input.paradis-tce-search', {
			type: 'search',
			placeholder: localize('paradis.themeColors.ui.search', "色を検索（例: ステータスバー、tab）"),
			'aria-label': localize('paradis.themeColors.ui.searchAria', "色を検索"),
		}));
		store.add(dom.addDisposableListener(this.searchInput, dom.EventType.INPUT, () => this.searchScheduler.schedule()));
		const pickButton = paradisCreateChip(searchRow, localize('paradis.themeColors.ui.pick', "画面から選ぶ"), store, () => this.delegate.startScreenPick());
		pickButton.classList.add('paradis-tce-pick');
		store.add(this.hoverService.setupDelayedHover(pickButton, { content: localize('paradis.themeColors.ui.pickHover', "画面の要素をクリックして、そこに効いている色を選びます") }));

		const tool = dom.append(list, $('.paradis-tce-tool', { role: 'radiogroup' }));
		const filters: [Filter, string][] = [
			['all', localize('paradis.themeColors.ui.filterAll', "すべて")],
			['modified', localize('paradis.themeColors.ui.filterModified', "変更した色")],
			['paraDefault', localize('paradis.themeColors.ui.filterPara', "Para Code 既定")],
		];
		for (const [filter, label] of filters) {
			const chip = paradisCreateChip(tool, label, store, () => {
				this.filter = filter;
				this.renderList();
			});
			chip.setAttribute('role', 'radio');
			this.chips.set(filter, chip);
		}
		this.items = dom.append(list, $('.paradis-tce-items', { role: 'listbox', 'aria-label': localize('paradis.themeColors.ui.listAria', "色の一覧") }));
		store.add(dom.addDisposableListener(this.items, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => this.onListKey(e)));

		// --- 右: 詳細 ---
		this.detail = dom.append(this.element, $('.paradis-tce-detail'));
		this.detailEmpty = dom.append(this.detail, $('.paradis-tce-detail-empty', undefined, localize('paradis.themeColors.ui.empty', "左の一覧から色を選ぶか、「画面から選ぶ」で画面の要素をクリックしてください。")));
		this.detailBody = dom.append(this.detail, $('.paradis-tce-detail-body'));
		this.detailId = dom.append(this.detailBody, $('.paradis-tce-detail-id'));
		this.detailDescription = dom.append(this.detailBody, $('.paradis-tce-detail-desc'));
		this.detailWarning = dom.append(this.detailBody, $('.paradis-tce-detail-warning'));
		this.picker = this._register(new ParadisColorPickerWidget(this.detailBody));
		this._register(this.draftService.registerFlushParticipant(() => this.picker.flush()));
		this._register(this.picker.onDidChange(color => {
			if (this.selectedId) {
				this.draftService.setColor(this.settingsId, this.selectedId, Color.Format.CSS.formatHexA(color, true).toUpperCase());
			}
		}));
		this.layers = dom.append(this.detailBody, $('.paradis-tce-layers'));
		const actions = dom.append(this.detailBody, $('.paradis-tce-actions'));
		this.revertParaButton = paradisCreateButton(actions, localize('paradis.themeColors.ui.revertPara', "Para Code の既定に戻す"), store, () => this.revertToParaDefault());
		this.revertThemeButton = paradisCreateButton(actions, localize('paradis.themeColors.ui.revertTheme', "テーマの色に戻す"), store, () => this.revertToTheme());
		this.undoButton = paradisCreateButton(actions, localize('paradis.themeColors.ui.undo', "この変更を取り消す"), store, () => this.undo());
		this.saveTarget = dom.append(this.detailBody, $('.paradis-tce-save-target'));

		this._register(this.draftService.onDidChange(() => this.refresh(false)));
		this._register(this.draftService.onDidChangeLayers(() => {
			this.refreshBadges([...this.rowBadges.keys()]);
			this.renderDetail(!this.isPickerFocused());
		}));
		let lastThemeId = this.themeService.getColorTheme().id;
		this._register(this.themeService.onDidColorThemeChange(theme => {
			// 設定の上書きが変わっただけでも呼ばれる。テーマ自体が変わったときだけ一覧を作り直す。
			if (theme.id !== lastThemeId) {
				lastThemeId = theme.id;
				this.renderList();
				this.renderDetail(true);
			} else {
				this.refreshSwatches();
				if (this.selectedId) {
					this.renderDetail(false);
				}
			}
		}));
		this._register(getColorRegistry().onDidChangeSchema(() => this.renderList()));
		this.renderList();
		this.renderDetail(true);
	}

	private get settingsId(): string {
		return this.themeService.getColorTheme().settingsId;
	}

	focus(): void {
		this.searchInput.focus();
	}

	/** 一覧を絞り込む語を入れる（画面から選べない所の案内などから）。 */
	setQuery(query: string): void {
		this.searchInput.value = query;
		this.filter = 'all';
		this.renderList();
	}

	/** その色を選んで見せる。絞り込みで隠れていれば絞り込みを外す。 */
	reveal(colorId: string): void {
		if (!this.rowElements.has(colorId)) {
			this.searchInput.value = '';
			this.filter = 'all';
			this.renderList();
		}
		this.select(colorId);
		this.rowElements.get(colorId)?.scrollIntoView({ block: 'center' });
	}

	private colors(): ColorContribution[] {
		return getColorRegistry().getColors().filter(color => !color.deprecationMessage);
	}

	private layersFor(): IParadisColorLayers {
		const layers = this.draftService.getLayers(PARADIS_COLOR_CUSTOMIZATIONS_KEY);
		const settingsId = this.settingsId;
		const edits = new Map<string, string | undefined>();
		for (const id of this.draftService.getColorEditIds(settingsId)) {
			edits.set(id, this.draftService.getColorEdit(settingsId, id)?.save);
		}
		return edits.size ? { ...layers, user: paradisApplyColorEdits(layers.user, settingsId, edits) } : layers;
	}

	private stateOf(colorId: string, layers: IParadisColorLayers): IColorState {
		const settingsId = this.settingsId;
		const pick = (layer: unknown) => {
			const read = paradisReadLayerColor(layer, settingsId, colorId);
			return read.scoped ?? read.unscoped;
		};
		return {
			origin: paradisResolveColorOrigin(layers, settingsId, colorId),
			userValue: pick(layers.user),
			paraValue: pick(layers.paraDefault),
			workspaceValue: pick(layers.workspace),
			hasDraft: !!this.draftService.getColorEdit(settingsId, colorId),
		};
	}

	private renderList(): void {
		const store = new DisposableStore();
		this.listStore.value = store;
		for (const [filter, chip] of this.chips) {
			chip.classList.toggle('on', filter === this.filter);
			chip.setAttribute('aria-checked', String(filter === this.filter));
		}
		const layers = this.layersFor();
		const theme = this.themeService.getColorTheme();
		const states = new Map<string, IColorState>();
		const entries = paradisFilterColorEntries(this.colors(), this.searchInput.value, groupLabel).filter(entry => {
			const state = this.stateOf(entry.id, layers);
			states.set(entry.id, state);
			switch (this.filter) {
				case 'modified': return state.userValue !== undefined || state.hasDraft;
				case 'paraDefault': return state.paraValue !== undefined;
				default: return true;
			}
		});

		dom.clearNode(this.items);
		this.rowSwatches.clear();
		this.rowElements.clear();
		this.rowBadges.clear();
		this.badgeKeys.clear();
		this.swatchValues.clear();
		this.lastDraftIds = new Set(this.draftService.getColorEditIds(this.settingsId));
		if (!entries.length) {
			dom.append(this.items, $('.paradis-tce-items-empty', undefined, localize('paradis.themeColors.ui.noMatch', "当てはまる色はありません")));
			return;
		}
		for (const group of paradisGroupColorEntries(entries, groupLabel)) {
			dom.append(this.items, $('.paradis-tce-group', undefined, localize('paradis.themeColors.ui.groupCount', "{0}（{1}）", group.label, group.entries.length)));
			for (const entry of group.entries) {
				const state = states.get(entry.id)!;
				const selected = entry.id === this.selectedId;
				const row = dom.append(this.items, $('.paradis-tce-item', { role: 'option', tabindex: selected ? '0' : '-1', 'aria-selected': String(selected) }));
				row.classList.toggle('selected', selected);
				const swatch = dom.append(row, $('span.paradis-tce-swatch'));
				const swatchValue = theme.getColor(entry.id)?.toString();
				paradisSetSwatch(swatch, swatchValue);
				this.swatchValues.set(entry.id, swatchValue);
				dom.append(row, $('span.paradis-tce-item-id', undefined, entry.id));
				const badge = dom.append(row, $('span.paradis-tce-item-badge'));
				this.renderBadge(entry.id, badge, state);
				this.rowBadges.set(entry.id, badge);
				this.rowSwatches.set(entry.id, swatch);
				this.rowElements.set(entry.id, row);
				store.add(this.hoverService.setupDelayedHover(row, { content: entry.description || entry.id }));
				store.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => this.select(entry.id)));
			}
		}
	}

	private renderBadge(colorId: string, container: HTMLElement, state: IColorState): void {
		const key = state.hasDraft ? 'draft' : state.origin.source;
		if (this.badgeKeys.get(colorId) === key) {
			return;
		}
		this.badgeKeys.set(colorId, key);
		dom.clearNode(container);
		if (state.hasDraft) {
			dom.append(container, $('span.paradis-tce-badge.user', undefined, localize('paradis.themeColors.badge.unsavedShort', "未保存")));
		} else if (state.origin.source === 'user') {
			dom.append(container, $('span.paradis-tce-badge.user', undefined, localize('paradis.themeColors.badge.user', "変更")));
		} else if (state.origin.source === 'workspace') {
			dom.append(container, $('span.paradis-tce-badge.user', undefined, localize('paradis.themeColors.badge.workspace', "ワークスペース")));
		} else if (state.origin.source === 'paraDefault') {
			dom.append(container, $('span.paradis-tce-badge.para', undefined, 'Para'));
		}
	}

	private select(colorId: string): void {
		const previous = this.selectedId;
		this.selectedId = colorId;
		if (previous) {
			const row = this.rowElements.get(previous);
			row?.classList.remove('selected');
			row?.setAttribute('tabindex', '-1');
			row?.setAttribute('aria-selected', 'false');
		}
		const row = this.rowElements.get(colorId);
		row?.classList.add('selected');
		row?.setAttribute('tabindex', '0');
		row?.setAttribute('aria-selected', 'true');
		this.renderDetail(true);
	}

	/** 一覧のキーボード操作: 上下の矢印で選び直し、Enter でピッカーへ移る。 */
	private onListKey(e: KeyboardEvent): void {
		const ids = [...this.rowElements.keys()];
		if (!ids.length) {
			return;
		}
		const index = this.selectedId ? ids.indexOf(this.selectedId) : -1;
		let next: number | undefined;
		switch (e.key) {
			case 'ArrowDown': next = Math.min(ids.length - 1, index + 1); break;
			case 'ArrowUp': next = Math.max(0, index - 1); break;
			case 'Home': next = 0; break;
			case 'End': next = ids.length - 1; break;
			case 'Enter':
			case ' ':
				e.preventDefault();
				if (index === -1) {
					this.select(ids[0]);
				}
				this.picker.focus();
				return;
		}
		if (next === undefined) {
			return;
		}
		e.preventDefault();
		this.select(ids[next]);
		const row = this.rowElements.get(ids[next]);
		row?.focus();
		row?.scrollIntoView({ block: 'nearest' });
	}

	/** 下書きが変わったとき。バッジは下書きの増減があった色だけ描き直す。ピッカーは、ピッカー自身の操作でないときだけ合わせ直す。 */
	private refresh(resetPicker: boolean): void {
		const current = new Set(this.draftService.getColorEditIds(this.settingsId));
		this.refreshBadges([...new Set([...this.lastDraftIds, ...current])]);
		this.lastDraftIds = current;
		this.renderDetail(resetPicker || !this.isPickerFocused());
	}

	private refreshBadges(colorIds: readonly string[]): void {
		const layers = this.layersFor();
		for (const id of colorIds) {
			const badge = this.rowBadges.get(id);
			if (badge) {
				this.renderBadge(id, badge, this.stateOf(id, layers));
			}
		}
	}

	private isPickerFocused(): boolean {
		return dom.isAncestorOfActiveElement(this.picker.element);
	}

	private refreshSwatches(): void {
		const theme = this.themeService.getColorTheme();
		for (const [id, swatch] of this.rowSwatches) {
			const value = theme.getColor(id)?.toString();
			if (this.swatchValues.get(id) !== value) {
				this.swatchValues.set(id, value);
				paradisSetSwatch(swatch, value);
			}
		}
	}

	private renderDetail(resetPicker: boolean): void {
		const colorId = this.selectedId;
		const contribution = colorId ? this.colors().find(color => color.id === colorId) : undefined;
		this.detailEmpty.style.display = contribution ? 'none' : '';
		this.detailBody.style.display = contribution ? '' : 'none';
		if (!contribution) {
			return;
		}
		const settingsId = this.settingsId;
		const theme = this.themeService.getColorTheme();
		const snapshot = this.draftService.getThemeSnapshot();
		const layers = this.layersFor();
		const state = this.stateOf(contribution.id, layers);
		const themeDefined = snapshot?.getColor(contribution.id, false);
		const themeResolved = snapshot ? snapshot.getColor(contribution.id) : undefined;
		const resolveSwatch = (value: string | undefined) => {
			if (value === undefined) {
				return undefined;
			}
			if (value === PARADIS_DEFAULT_COLOR_VALUE) {
				return snapshot?.getDefault(contribution.id)?.toString();
			}
			return Color.Format.CSS.parseHex(value)?.toString();
		};

		this.detailId.textContent = contribution.id;
		this.detailDescription.textContent = contribution.description;
		const warnings: string[] = [];
		if (contribution.needsTransparency) {
			warnings.push(localize('paradis.themeColors.ui.needsTransparency', "この色は下の内容に重ねて塗られます。不透明な色にすると下が隠れるので、不透明度を下げてください。"));
		}
		if (state.origin.source !== 'workspace' && paradisExactScopeShadowed(layers.user, settingsId, contribution.id)) {
			warnings.push(localize('paradis.themeColors.ui.shadowed', "settings.json の {0} より後ろにある別のテーマ用のキー（\"[A][{1}]\" など）にもこの色があり、そちらが勝つため、ここで変えた値は効きません。", `"${paradisThemeScopeKey(settingsId)}"`, settingsId));
		}
		if (state.origin.source === 'workspace') {
			warnings.push(localize('paradis.themeColors.ui.workspaceWins', "ワークスペースの設定がこの色を上書きしているため、ここで変えても保存後はワークスペースの色が使われます。"));
		}
		this.detailWarning.textContent = warnings.join(' ');
		this.detailWarning.style.display = warnings.length ? '' : 'none';

		if (resetPicker) {
			this.picker.setColor(theme.getColor(contribution.id));
		}

		const themeLabel = localize('paradis.themeColors.ui.layerTheme', "テーマ（{0}）の色", theme.label);
		const rows = [
			{ label: localize('paradis.themeColors.ui.layerUser', "自分で変えた色"), value: state.userValue, swatch: resolveSwatch(state.userValue), active: state.origin.source === 'user', unsaved: state.hasDraft },
			{ label: localize('paradis.themeColors.ui.layerPara', "Para Code の既定"), value: state.paraValue, swatch: resolveSwatch(state.paraValue), active: state.origin.source === 'paraDefault' },
			{
				label: themeLabel,
				value: themeDefined ? Color.Format.CSS.formatHexA(themeDefined, true) : (themeResolved ? Color.Format.CSS.formatHexA(themeResolved, true) : undefined),
				swatch: themeResolved?.toString(),
				active: state.origin.source === 'theme',
			},
		];
		if (state.workspaceValue !== undefined) {
			rows.splice(0, 0, { label: localize('paradis.themeColors.ui.layerWorkspace', "ワークスペースの設定"), value: state.workspaceValue, swatch: resolveSwatch(state.workspaceValue), active: state.origin.source === 'workspace' });
		}
		paradisRenderLayerRows(this.layers, rows);

		this.revertParaButton.enabled = state.paraValue !== undefined && state.origin.source !== 'paraDefault';
		this.revertThemeButton.enabled = state.origin.source !== 'theme';
		this.undoButton.enabled = state.hasDraft;
		this.saveTarget.textContent = localize('paradis.themeColors.ui.saveTarget', "保存先: ユーザー設定の {0} の中", `"${paradisThemeScopeKey(settingsId)}"`);
	}

	private revertToParaDefault(): void {
		const colorId = this.selectedId;
		if (!colorId) {
			return;
		}
		const settingsId = this.settingsId;
		const layers = this.layersFor();
		const withoutUser = { ...layers, user: paradisApplyColorEdits(layers.user, settingsId, new Map([[colorId, undefined]])) };
		// 消すだけで既定に戻らない（スコープなしや別のキーにも値がある）ときは、既定の値を明示的に書く。
		this.draftService.setColor(settingsId, colorId, paradisPlanRevertToParaDefault(withoutUser, settingsId, colorId));
		this.renderDetail(true);
	}

	private revertToTheme(): void {
		const colorId = this.selectedId;
		if (!colorId) {
			return;
		}
		const settingsId = this.settingsId;
		const layers = this.layersFor();
		const withoutUser = { ...layers, user: paradisApplyColorEdits(layers.user, settingsId, new Map([[colorId, undefined]])) };
		const themeColor = this.draftService.getThemeSnapshot()?.getColor(colorId, false);
		const save = paradisPlanRevertToTheme(withoutUser, settingsId, colorId, themeColor ? Color.Format.CSS.formatHexA(themeColor, true).toUpperCase() : undefined);
		this.draftService.setColor(settingsId, colorId, save);
		this.renderDetail(true);
	}

	private undo(): void {
		if (this.selectedId) {
			this.draftService.dropColorEdit(this.settingsId, this.selectedId);
			this.renderDetail(true);
		}
	}
}
