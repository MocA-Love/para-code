/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ピン留めコマンドプリセット群を1つのアクションとしてまとめて描画するツールバー項目。
//
// 幅に余裕があるときは個々のボタンをそのまま並べ、タブ側が窮屈になる（縮む・スクロールする）と
// 判断したときだけ、1個の「まとめアイコン」に折りたたんでホバーで展開する。固定の幅しきい値では
// なく、実測したタブの必要幅とプリセット行の必要幅を毎回比較して決める——ターミナルの幅・タブの
// 数や長さ・プリセットの数の組み合わせが変わっても、同じロジックで妥当な結果になるようにするため。
//
// 実装様式はタイトルバーの「エージェント一覧」ウィジェット（paradisAgentLiveWindow.contribution.ts
// の ParadisAgentLiveTitleBarWidget）と同じ BaseActionViewItem + IActionViewItemService パターン。
// タブ側の実測は、DOM を持たない（＝上流の実装に触れない）読み取り専用の観測に徹する——
// .tabs-container が見つからない場合は折りたたみ機能そのものを無効化し、今日どおり常に展開表示
// する（アップストリーム側のDOM構造が将来変わっても、機能が静かに退化するだけで壊れない設計）。
//
// 実DOM構造（multiEditorTabsControl.ts / multieditortabscontrol.css）:
//   .tabs-and-actions-container
//     > .monaco-scrollable-element      ← ScrollableElement が1段挟まる
//         > .tabs-container
//     > .editor-actions                 ← このクラスターもこの中に居る
//
// ホバー展開のフライアウトは左（タブ側）へ伸びるが、伸ばしっぱなしにすると分割ペインが狭い時や
// サイドバーが開いている時に隣のペイン・サイドバーへ被さって見える。.tabs-and-actions-container
// （＝このエディタグループ自身）の左端までの実測距離を上限にし、必ず自分のペインの中に収める
// （updateFlyoutMaxWidth）。
//
// 全プリセットが1個の合成アクションに統合されたため、VS Code 標準のツールバー右クリック
// 「Hide '<名前>'」（MenuId + commandId 単位で個別に効く機能。src/vs/platform/actions/browser/
// toolbar.ts の WorkbenchToolBar 参照）はこのクラスター全体を1項目としてしか隠せなくなった。
// 代わりにボタン単位の右クリックで showHideMenu を出し、以前と同じ「プリセットごとにタブバーから
// 非表示にする」操作を再現している。書き込み先は保存元で分ける（hidePreset 参照）: user ソースは
// 自分の設定なので pinned フィールドへ直接書き込むが、workspace ソース（.paracode.json 由来）へ
// 同じことをすると git で共有される定義元ファイルがチーム全員分書き換わってしまうため、
// このマシンだけの非表示台帳（setWorkspacePresetLocallyHidden）へ記録する。

import './media/paradisPresetCluster.css';
import * as dom from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderLabelWithIcons } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import {
	IParadisPresetService,
	IParadisResolvedPreset,
	paradisPresetQualifiers,
	paradisPresetTooltip,
} from '../common/paradisTerminalPresets.js';

const $ = dom.$;

// allow-any-unicode-next-line
const strClusterAriaLabel = (count: number) => localize('paradis.presetCluster.ariaLabel', "コマンドプリセット {0} 件（ホバーで展開）", count);
// allow-any-unicode-next-line
const strPresetGroupTitle = (name: string, count: number) => localize('paradis.presetCluster.groupTitle', "{0}（{1}件）", name, count);
// allow-any-unicode-next-line
const strRunFailed = (name: string, message: string) => localize('paradis.presetCluster.runFailed', "プリセット「{0}」を実行できませんでした: {1}", name, message);
// allow-any-unicode-next-line
const strHideLabel = (name: string, qualifier: string | undefined) => qualifier
	// allow-any-unicode-next-line
	? localize('paradis.presetCluster.hideLabelQualified', "非表示にする: {0} ({1})", name, qualifier)
	// allow-any-unicode-next-line
	: localize('paradis.presetCluster.hideLabel', "非表示にする: {0}", name);
// allow-any-unicode-next-line
const strHiddenNotice = (name: string) => localize('paradis.presetCluster.hiddenNotice', "「{0}」をターミナルのタブバーから非表示にしました。「コマンドプリセットを管理」からいつでも戻せます。", name);
// allow-any-unicode-next-line
const strHiddenNoticeWorkspace = (name: string) => localize('paradis.presetCluster.hiddenNoticeWorkspace', "「{0}」をこの端末のタブバーからだけ非表示にしました（このリポジトリの設定ファイルは変更していません）。「コマンドプリセットを管理」からいつでも戻せます。", name);
// allow-any-unicode-next-line
const STR_UNDO_HIDE = localize('paradis.presetCluster.undoHide', "元に戻す");
// allow-any-unicode-next-line
const strHideFailed = (name: string, message: string) => localize('paradis.presetCluster.hideFailed', "プリセット「{0}」を非表示にできませんでした: {1}", name, message);
// allow-any-unicode-next-line
const STR_MANAGE_PRESETS = localize('paradis.presetCluster.managePresets', "コマンドプリセットを管理...");
const CONFIGURE_PRESETS_COMMAND_ID = 'paradis.terminal.configurePresets';

/** これ未満のボタン数（同名は1個にまとめた後の件数）では、折りたたんでも浮く幅がわずかで手間が増えるだけなので機能自体を無効にする。 */
const MIN_GROUPS_TO_COLLAPSE = 3;
/** 畳む／戻すの境界でちらつかないための余裕（px）。畳むにも戻すにもこの分だけ明確な余裕が要る。 */
const HYSTERESIS_PX = 24;
/** タブの変更（追加・削除・並べ替え・タイトル変更）をこの間隔で合流させてから測り直す。 */
const TABS_REMEASURE_DEBOUNCE_MS = 50;
/**
 * マウスがまとめアイコン（またはフライアウト）から外れてから、実際にフライアウトを閉じるまでの
 * 猶予（ms）。0 だと :hover が一瞬でも外れた瞬間に閉じてしまい、アイコンからフライアウト内の
 * ボタンへ斜めにカーソルを動かす普通の操作でも閉じやすくなる。
 */
const HOVER_CLOSE_DELAY_MS = 300;

export class ParadisPresetClusterViewItem extends BaseActionViewItem {

	private readonly contentStore = this._register(new DisposableStore());
	private readonly observerStore = this._register(new DisposableStore());

	private container: HTMLElement | undefined;
	private fullEl: HTMLElement | undefined;
	private collapsedWrap: HTMLElement | undefined;
	private closeScheduler: RunOnceScheduler | undefined;
	private row: HTMLElement | undefined;
	private tabsContainer: HTMLElement | undefined;

	private collapsed = false;
	private groupCount = 0;
	private cachedFullNaturalWidth = 0;
	private cachedTabsNaturalWidth = 0;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@IParadisPresetService private readonly presetService: IParadisPresetService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IHoverService private readonly hoverService: IHoverService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		// render() はツールバーの再構築のたびに呼ばれうる。二重に購読・観測しないよう、
		// 前回ぶんの store を作り直すところから始める（既存の disposable を確実に切ってから積む）。
		this.observerStore.clear();
		// observer と同じく、前の container で解決した参照も捨てる。ここを残したままだと、
		// 次のフレームで attachResponsiveObservers() が新しい row/tabsContainer を見つけるまでの間、
		// 切り離された（幅0の）古い要素を根拠に折りたたみ判定が走ってしまう。新しい場所で
		// .tabs-and-actions-container が見つからなかった場合も、これを消さないと古い参照のまま
		// 「折りたたみ機能を無効化する」という設計意図（見つからなければ常に展開表示）が崩れる。
		this.row = undefined;
		this.tabsContainer = undefined;
		// 折りたたみ判定も展開状態から仕切り直す。次のフレームで再度見つかるまでの間、および
		// 万一 .tabs-container が見つからなかった場合の両方で「常に展開表示」の約束を守るため。
		this.collapsed = false;
		container.classList.add('paradis-preset-cluster');
		this.container = container;

		this.observerStore.add(this.presetService.onDidChangePresets(() => this.rebuildContent()));
		this.rebuildContent();

		// render() の時点ではまだ DOM ツリーに接続されていない（ActionBar は appendChild の前に
		// render を呼ぶ）。closest() で .tabs-and-actions-container を探すのは次のフレームまで待つ。
		const win = dom.getWindow(container);
		this.observerStore.add(dom.scheduleAtNextAnimationFrame(win, () => this.attachResponsiveObservers()));
	}

	// --- 描画 -----------------------------------------------------------------------------------

	private rebuildContent(): void {
		const container = this.container;
		if (!container) {
			return;
		}
		this.contentStore.clear();
		dom.clearNode(container);
		this.fullEl = undefined;
		this.collapsedWrap = undefined;
		this.closeScheduler = undefined;

		// hosts 条件が現在の接続先と一致しないプリセット（envInactive）はタブバーにも出さない。
		const pinned = this.presetService.presets.filter(preset => preset.pinned !== false && !preset.locallyHidden && !preset.envInactive);
		if (pinned.length === 0) {
			container.style.display = 'none';
			this.groupCount = 0;
			return;
		}
		container.style.display = '';

		const qualifiers = paradisPresetQualifiers(pinned);
		// 同じ名前のピン留めプリセットは1つのボタンにまとめる。同名のボタンが2つ並ぶと、
		// 押すまで違いが分からないまま実際にコマンドが走ってしまう。
		const byName = new Map<string, IParadisResolvedPreset[]>();
		for (const preset of pinned) {
			const name = preset.name.trim();
			const group = byName.get(name);
			if (group) {
				group.push(preset);
			} else {
				byName.set(name, [preset]);
			}
		}
		const groups = [...byName.values()];
		this.groupCount = groups.length;

		const fullEl = dom.append(container, $('.paradis-preset-cluster-full'));
		this.fullEl = fullEl;
		// collapsedWrap 自体は role を持たない純粋なホバー当たり判定・位置決めの箱。
		// フォーカス可能・アクセシブルネームを持つのは実際にクリックできる clusterBtn（<button>）側。
		const collapsedWrap = dom.append(container, $('.paradis-preset-cluster-collapsed'));
		this.collapsedWrap = collapsedWrap;
		const clusterBtn = dom.append(collapsedWrap, $('button.paradis-preset-cluster-btn')) as HTMLButtonElement;
		clusterBtn.type = 'button';
		clusterBtn.setAttribute('aria-label', strClusterAriaLabel(groups.length));
		dom.append(clusterBtn, $('span.paradis-preset-cluster-icon.codicon.codicon-layers'));
		dom.append(clusterBtn, $('span.paradis-preset-cluster-badge')).textContent = String(groups.length);
		// まとめアイコン自体の右クリックは「どれか1件」に対応しないので、含まれる全プリセットを
		// 横断した非表示メニューを出す（展開して個々のボタンを右クリックする手間を省く）。
		this.contentStore.add(dom.addDisposableListener(clusterBtn, 'contextmenu', e => {
			dom.EventHelper.stop(e, true);
			this.showHideMenu(clusterBtn, groups.flat(), qualifiers);
		}));
		const flyout = dom.append(collapsedWrap, $('.paradis-preset-cluster-flyout'));
		// CSS の :hover はカーソルがこの要素（とその子孫）の描画領域から1pxでも外れた瞬間に外れる。
		// まとめアイコンからフライアウトへ斜めに動かす途中で、境界のわずかな隙間を一瞬でも通ると
		// そこで閉じてしまい、中のボタンまで辿り着けない——「はみ出すとすぐ閉じる」の正体はこれ。
		// マウス操作だけは :hover に直結させず、実際に閉じるまで少し待つ猶予（closeScheduler）を
		// JS 側で持たせる。キーボード操作（Tabでのフォーカス移動）はこの猶予が要らないので、CSS の
		// :focus-within は今までどおり即時のまま別枠で残す（下の CSS 参照）。
		const closeScheduler = this.contentStore.add(new RunOnceScheduler(() => {
			collapsedWrap.classList.remove('is-open');
			// :focus-within でまだ開いている（Tab でフライアウト内へ入ってからマウスを乗せて
			// 外した等）なら、表示中のスクロール位置を巻き戻さない。
			if (!collapsedWrap.matches(':focus-within')) {
				flyout.scrollLeft = 0;
			}
		}, HOVER_CLOSE_DELAY_MS));
		this.closeScheduler = closeScheduler;
		this.contentStore.add(dom.addDisposableListener(collapsedWrap, 'mouseenter', () => {
			closeScheduler.cancel();
			collapsedWrap.classList.add('is-open');
		}));
		this.contentStore.add(dom.addDisposableListener(collapsedWrap, 'mouseleave', () => {
			closeScheduler.schedule();
		}));
		// キーボードでフォーカスが完全に外へ出たときだけスクロール位置を戻す
		// （フライアウト内をTabで移動しているだけなら relatedTarget も子孫のまま）。
		this.contentStore.add(dom.addDisposableListener(collapsedWrap, 'focusout', e => {
			if (collapsedWrap.contains(e.relatedTarget as Node | null)) {
				return;
			}
			flyout.scrollLeft = 0;
		}));

		for (const group of groups) {
			this.renderItem(fullEl, group, qualifiers);
			this.renderItem(flyout, group, qualifiers);
		}

		container.classList.toggle('is-collapsed', this.collapsed);
		this.measureFullNaturalWidth();
		this.evaluateCollapse();
	}

	private renderItem(target: HTMLElement, group: readonly IParadisResolvedPreset[], qualifiers: Map<string, string>): void {
		const preset = group[0];
		const btn = dom.append(target, $('button.paradis-preset-cluster-item')) as HTMLButtonElement;
		btn.type = 'button';
		const iconId = preset.icon ?? 'play';

		if (group.length > 1) {
			const groupTitle = strPresetGroupTitle(preset.name.trim(), group.length);
			dom.append(btn, $('span.paradis-preset-cluster-item-icon')).classList.add(...ThemeIcon.asClassNameArray(ThemeIcon.fromId(iconId)));
			btn.setAttribute('aria-label', groupTitle);
			const hover = this.contentStore.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), btn, ''));
			hover.update(groupTitle);
			this.contentStore.add(dom.addDisposableListener(btn, 'click', e => {
				dom.EventHelper.stop(e, true);
				this.showGroupMenu(btn, group, qualifiers);
			}));
			this.contentStore.add(dom.addDisposableListener(btn, 'contextmenu', e => {
				dom.EventHelper.stop(e, true);
				this.showHideMenu(btn, group, qualifiers);
			}));
			return;
		}

		if (preset.pinnedLabel === true) {
			const label = dom.append(btn, $('span.paradis-preset-cluster-item-label'));
			dom.reset(label, ...renderLabelWithIcons(`$(${iconId}) ${preset.name}`));
		} else {
			dom.append(btn, $('span.paradis-preset-cluster-item-icon')).classList.add(...ThemeIcon.asClassNameArray(ThemeIcon.fromId(iconId)));
		}
		const qualifier = qualifiers.get(preset.key);
		const tooltip = paradisPresetTooltip(preset, qualifier);
		btn.setAttribute('aria-label', tooltip);
		const hover = this.contentStore.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), btn, ''));
		hover.update(tooltip);
		this.contentStore.add(dom.addDisposableListener(btn, 'click', e => {
			dom.EventHelper.stop(e, true);
			this.presetService.runPreset(preset).catch(error => this.notificationService.error(strRunFailed(preset.name, toErrorMessage(error))));
		}));
		this.contentStore.add(dom.addDisposableListener(btn, 'contextmenu', e => {
			dom.EventHelper.stop(e, true);
			this.showHideMenu(btn, [preset], qualifiers);
		}));
	}

	private showGroupMenu(anchor: HTMLElement, group: readonly IParadisResolvedPreset[], qualifiers: Map<string, string>): void {
		const actions: IAction[] = group.map(preset => toAction({
			id: `paradis.presetCluster.run.${preset.key}`,
			label: qualifiers.get(preset.key) ? `${preset.name} — ${qualifiers.get(preset.key)}` : preset.name,
			class: ThemeIcon.asClassName(ThemeIcon.fromId(preset.icon ?? 'play')),
			run: () => this.presetService.runPreset(preset).catch(error => this.notificationService.error(strRunFailed(preset.name, toErrorMessage(error)))),
		}));
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}

	/**
	 * 右クリックで「非表示にする」を選べるメニュー。以前の実装（プリセットごとに個別の
	 * MenuItemAction を登録していた頃）は、VS Code 標準のツールバー右クリック「Hide '<名前>'」が
	 * プリセット単位で独立して効いていた。今はすべてのピン留めプリセットが1個の合成アクションへ
	 * まとまっているため、その標準機能は「クラスター全体を1項目として隠す」ことしかできない
	 * （個々のプリセット単位の表示/非表示切り替えができなくなる）。同等の操作をアプリ側の
	 * `pinned` フィールド（user ソース）または、このマシンだけの非表示台帳（workspace ソース）
	 * 経由で再現する（実際の分岐は {@link hidePreset} 参照）。
	 */
	private showHideMenu(anchor: HTMLElement, presets: readonly IParadisResolvedPreset[], qualifiers: Map<string, string>): void {
		const actions: IAction[] = presets.map(preset => toAction({
			id: `paradis.presetCluster.hide.${preset.key}`,
			label: strHideLabel(preset.name, qualifiers.get(preset.key)),
			run: () => this.hidePreset(preset),
		}));
		if (actions.length > 0) {
			actions.push(new Separator());
		}
		actions.push(toAction({
			id: CONFIGURE_PRESETS_COMMAND_ID,
			label: STR_MANAGE_PRESETS,
			run: () => this.commandService.executeCommand(CONFIGURE_PRESETS_COMMAND_ID),
		}));
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}

	/**
	 * workspace ソース（.paracode.json 由来）は、このマシンだけの非表示台帳へ記録する
	 * （定義元ファイルには一切書き込まない——リポジトリの持ち主が登録したプリセットを、
	 * 自分の画面でだけ隠したいだけで、チーム共有ファイルへ差分を作りたいわけではないため）。
	 * user ソースは自分の設定なので、従来どおり `pinned` フィールドへ直接書き込む。
	 */
	private async hidePreset(preset: IParadisResolvedPreset): Promise<void> {
		// 隠した直後が一番「元に戻したい」タイミング。管理ダイアログまで探しに行かなくても
		// その場で戻せるよう、通知自体に元に戻すアクションを付ける。
		const undoAction = (run: () => void) => toAction({ id: 'paradis.presetCluster.undoHide', label: STR_UNDO_HIDE, run });
		if (preset.source === 'workspace') {
			this.presetService.setWorkspacePresetLocallyHidden(preset, true);
			this.notificationService.notify({
				severity: Severity.Info,
				message: strHiddenNoticeWorkspace(preset.name),
				actions: { primary: [undoAction(() => this.presetService.setWorkspacePresetLocallyHidden(preset, false))] },
			});
			return;
		}
		try {
			await this.presetService.setPresetPinned(preset, false);
			this.notificationService.notify({
				severity: Severity.Info,
				message: strHiddenNotice(preset.name),
				actions: { primary: [undoAction(() => { this.presetService.setPresetPinned(preset, true).catch(error => this.notificationService.error(strHideFailed(preset.name, toErrorMessage(error)))); })] },
			});
		} catch (error) {
			this.notificationService.error(strHideFailed(preset.name, toErrorMessage(error)));
		}
	}

	/**
	 * .paradis-preset-cluster-full の自然幅を測る。折りたたみ中は display:none なので、
	 * 一時的に is-collapsed を外してから測り、直後に元へ戻す（見た目には出ない一瞬の操作）。
	 */
	private measureFullNaturalWidth(): void {
		const container = this.container;
		const fullEl = this.fullEl;
		if (!container || !fullEl) {
			return;
		}
		const wasCollapsed = container.classList.contains('is-collapsed');
		container.classList.remove('is-collapsed');
		this.cachedFullNaturalWidth = fullEl.getBoundingClientRect().width;
		container.classList.toggle('is-collapsed', wasCollapsed);
	}

	// --- 幅に応じた折りたたみ ---------------------------------------------------------------------

	/**
	 * .tabs-container を見つけて監視を始める。見つからない場合（アップストリームのDOM構造が
	 * 変わった等）は折りたたみ機能を諦め、常に展開表示のまま（今日と同じ見た目）にする。
	 */
	private attachResponsiveObservers(): void {
		const container = this.container;
		if (!container) {
			return;
		}
		const row = container.closest<HTMLElement>('.tabs-and-actions-container');
		// eslint-disable-next-line no-restricted-syntax -- 自前で持たない上流(editorTabsControl)所有のDOMを覗くだけで、要素構築ではない。見つからなければ折りたたみ機能自体を無効化する
		const tabsContainer = row?.querySelector<HTMLElement>('.tabs-container');
		if (!row || !tabsContainer) {
			return;
		}
		this.row = row;
		this.tabsContainer = tabsContainer;

		// 接続前の初回描画では .paradis-preset-cluster-full の幅測定が 0 になっている
		// （render() は appendChild より先に呼ばれるため）。接続が確定したここで測り直す。
		this.measureFullNaturalWidth();

		const remeasureTabs = () => {
			// .tabs-container 自身がスクロールコンテナなので、内容が縮められていなければ
			// scrollWidth がそのまま「収まりきらない分も含めた必要幅」になる。
			this.cachedTabsNaturalWidth = tabsContainer.scrollWidth;
			this.evaluateCollapse();
		};
		remeasureTabs();

		// タブの追加・削除・並べ替え・タイトル変更のたびに必要幅を測り直す。DOM 変更イベントが
		// 連続で飛んでくることがあるため、RunOnceScheduler で合流させてから測る。
		const scheduler = this.observerStore.add(new RunOnceScheduler(remeasureTabs, TABS_REMEASURE_DEBOUNCE_MS));
		this.observerStore.add(dom.sharedMutationObserver.observe(tabsContainer, this.observerStore, { childList: true, subtree: true, characterData: true })(() => scheduler.schedule()));

		// 幅そのものの変化（ウィンドウ・パネルのリサイズ、分割の追加等）は、キャッシュ済みの
		// 必要幅と現在の実測値を比べるだけなので毎回の再測定は不要。
		const win = dom.getWindow(row);
		const resizeObserver = this.observerStore.add(new dom.DisposableResizeObserver('paradisPresetCluster', () => this.evaluateCollapse(), win));
		this.observerStore.add(resizeObserver.observe(row));
	}

	private evaluateCollapse(): void {
		const container = this.container;
		const row = this.row;
		const tabsContainer = this.tabsContainer;
		if (!container || !row || !tabsContainer) {
			return;
		}
		if (this.groupCount < MIN_GROUPS_TO_COLLAPSE) {
			this.setCollapsed(container, false);
			return;
		}
		// tabs-and-actions-container の全体幅 = タブ列の現在幅 + アクション列の現在幅（このクラスター
		// 自身を含む）。この関係は折りたたみ状態に関わらず常に成り立つため、「クラスター以外の
		// アクション（New Terminal・Open Browser・全プリセット・管理ボタン等）が占めている幅」を
		// 差分から逆算できる——上流のアクション構成を知らなくても求まる。
		const rowWidth = row.getBoundingClientRect().width;
		const tabsCurrentWidth = tabsContainer.getBoundingClientRect().width;
		const myCurrentWidth = container.getBoundingClientRect().width;
		const otherFixedWidth = rowWidth - tabsCurrentWidth - myCurrentWidth;

		const availableForTabsIfExpanded = rowWidth - otherFixedWidth - this.cachedFullNaturalWidth;
		const deficitIfExpanded = this.cachedTabsNaturalWidth - availableForTabsIfExpanded; // > 0 ならタブが窮屈になる

		const shouldCollapse = this.collapsed
			? deficitIfExpanded > -HYSTERESIS_PX // 戻すには明確な余裕が要る
			: deficitIfExpanded > HYSTERESIS_PX;  // 畳むにも明確な窮屈さが要る
		this.setCollapsed(container, shouldCollapse);
		// setCollapsed の後で測る。折りたたみ時だけ表示される要素（display:none で解除される）を
		// 測るので、is-collapsed の適用より先に読むと常に幅0（フォールバック値）になってしまう。
		if (this.collapsed) {
			this.updateFlyoutMaxWidth(container, row);
		}
	}

	/**
	 * ホバー展開のフライアウトが、このエディタグループ（＝このターミナルのペイン）の左端を
	 * 越えて伸びないよう上限を設定する。CSS 側は `max-width: 70vw` を素朴な既定値にしていたが、
	 * ウィンドウ幅の70%はペインが分割やサイドバーで狭くなっているときには大きすぎ、隣のペインや
	 * サイドバーへ被さって見えてしまう。フライアウトは（畳んだ）まとめアイコンの左辺から左へ
	 * 伸びる作りなので、そこから row（.tabs-and-actions-container＝このペインの左端と揃う）の
	 * 左端までの実測距離を上限にすれば、常にこのペインの中に収まる。
	 */
	private updateFlyoutMaxWidth(container: HTMLElement, row: HTMLElement): void {
		const collapsedWrap = this.collapsedWrap;
		if (!collapsedWrap) {
			return;
		}
		const available = collapsedWrap.getBoundingClientRect().left - row.getBoundingClientRect().left;
		// 極端に狭いペインでもフライアウト自体は多少残す（横スクロールで拾える範囲に収める）。
		// これを大きくしすぎるとペインの外へ出てしまうので、あくまで最小限の可読幅にとどめる。
		const MIN_FLYOUT_WIDTH = 80;
		container.style.setProperty('--paradis-preset-cluster-flyout-max-width', `${Math.max(MIN_FLYOUT_WIDTH, Math.floor(available))}px`);
	}

	private setCollapsed(container: HTMLElement, value: boolean): void {
		if (this.collapsed === value) {
			return;
		}
		this.collapsed = value;
		container.classList.toggle('is-collapsed', value);
		if (!value) {
			// 折りたたみを解除するときは開いた状態を必ず捨てる。collapsedWrap が display:none へ
			// 遷移するとき、mouseleave が確実に飛ぶ保証はない（次のマウス移動まで境界イベントが
			// 再評価されないことがある）——放置すると is-open が残り、次に折りたたんだ瞬間、
			// ホバーしていないのにフライアウトが開いた状態で現れる。
			this.closeScheduler?.cancel();
			this.collapsedWrap?.classList.remove('is-open');
		}
	}
}
