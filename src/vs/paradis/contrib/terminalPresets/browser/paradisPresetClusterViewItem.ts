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
//
// folder を持つピン留めプリセットは、名前が違っても同じフォルダとして1ボタンにまとめる
// （paradisGroupPresetsByFolder）。中身が複数プリセットでも、名前が1件だけの同名まとめグループ
// （下記の group.length > 1 の分岐）と同じ描画パターン（アイコン＋件数入りツールチップ、クリックで
// 内訳メニュー）を流用する——タブバーのボタン数を増やさずに済み、実装も1本化できる。
//
// 内訳メニュー（showGroupMenu）は IContextMenuService を使わず自前の HTML/CSS ポップアップにして
// いる。IContextMenuService はビルド種別・設定（window.menuStyle）次第で Electron のネイティブ
// メニューへ委譲されることがあり（macOS は既定で native）、その場合 OS ネイティブ風の見た目になって
// 他のツールバー項目・フライアウトと質感が揃わない。詳細は showGroupMenu / positionPopup 参照。

import './media/paradisPresetCluster.css';
import * as dom from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderLabelWithIcons } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname } from '../../../../base/common/resources.js';
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
	paradisGroupPresetsByFolder,
	paradisPresetFolderKey,
	paradisPresetQualifiers,
	paradisPresetTooltip,
} from '../common/paradisTerminalPresets.js';

const $ = dom.$;

// allow-any-unicode-next-line
const strClusterAriaLabel = (count: number) => localize('paradis.presetCluster.ariaLabel', "コマンドプリセット {0} 件（ホバーで展開）", count);
// allow-any-unicode-next-line
const strPresetGroupTitle = (name: string, count: number) => localize('paradis.presetCluster.groupTitle', "{0}（{1}件）", name, count);
// allow-any-unicode-next-line
const STR_FOLDER_SCOPE_USER = localize('paradis.presetCluster.folderScopeUser', "ユーザー");
// allow-any-unicode-next-line
const STR_FOLDER_SCOPE_WORKSPACE = localize('paradis.presetCluster.folderScopeWorkspace', "リポジトリ");
/** 同名の folder ボタンが複数あるときだけ、どちらのスコープのフォルダかをラベルへ付記する。 */
// allow-any-unicode-next-line
const strFolderLabelWithScope = (name: string, scope: string) => localize('paradis.presetCluster.folderLabelWithScope', "{0}（{1}）", name, scope);
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
// allow-any-unicode-next-line
const STR_SHOW_FOLDER_LABEL = localize('paradis.presetCluster.showFolderLabel', "フォルダ名も表示する");
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

/**
 * ツールバーに実際に描画する1個のボタン単位。folder が付いているものはフォルダ丸ごと1グループ
 * （中身が複数プリセットでも1ボタン）、folder が無いものは同名プリセットをまとめたグループ
 * （従来どおり）。
 */
interface IParadisPresetClusterGroup {
	readonly folderLabel?: string;
	readonly presets: IParadisResolvedPreset[];
}

export class ParadisPresetClusterViewItem extends BaseActionViewItem {

	private readonly contentStore = this._register(new DisposableStore());
	private readonly observerStore = this._register(new DisposableStore());
	/**
	 * フォルダ／同名まとめの内訳メニュー。`IContextMenuService` を経由すると、macOS の既定設定
	 * （window.menuStyle: native）では Electron のネイティブメニューに委譲されてしまい、他の
	 * ツールバー項目と見た目が揃わない（OSネイティブ風のポップアップになる）。ここだけは
	 * `.paradis-preset-cluster-flyout` と同じ自前 HTML/CSS のポップアップにして、テーマ・見た目を
	 * 統一する。開いている間だけ非 undefined。
	 */
	private readonly popupStore = this._register(new MutableDisposable<DisposableStore>());
	private popupAnchor: HTMLElement | undefined;

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
		// 再構築でボタンが作り直されると、開いていたポップアップの anchor が古い（DOMから外れた）
		// 要素を指したままになる。位置がズレたまま浮き続けないよう先に閉じる。
		this.closePopup();
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
		// folder を持つプリセットはフォルダ単位で1グループにまとめる（中身が複数でも1ボタン）。
		// folder を持たない単独プリセットは、従来どおり同じ名前同士でさらにまとめる——同名のボタンが
		// 2つ並ぶと、押すまで違いが分からないまま実際にコマンドが走ってしまうため。
		const folderGroups = paradisGroupPresetsByFolder(pinned);
		const groups: IParadisPresetClusterGroup[] = [];
		const nameIndex = new Map<string, number>();
		for (const folderGroup of folderGroups) {
			// フォルダボタン化するのは中身が複数あるときだけ。1件しか無いフォルダをボタン化すると、
			// クリック→内訳メニュー→本体クリックの2手に退化するうえ、そのプリセットが持つ
			// pinnedLabel/icon の設定も無視されてしまう——同名まとめルート（下記）へ流し、
			// 単独プリセットとして通常どおり描画する。
			if (folderGroup.folder !== undefined && folderGroup.presets.length > 1) {
				groups.push({ folderLabel: folderGroup.folder, presets: [...folderGroup.presets] });
				continue;
			}
			const preset = folderGroup.presets[0];
			const name = preset.name.trim();
			const existingIndex = nameIndex.get(name);
			if (existingIndex !== undefined) {
				groups[existingIndex].presets.push(preset);
			} else {
				nameIndex.set(name, groups.length);
				groups.push({ presets: [preset] });
			}
		}
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
			this.showHideMenu(clusterBtn, groups.flatMap(group => group.presets), qualifiers);
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
			// フライアウトが自動で畳まれると、その中のフォルダボタンをアンカーに開いていた内訳
			// ポップアップだけが宙に浮いて残ってしまう。アンカーが見えなくなるタイミングでは
			// 必ず一緒に閉じる。
			this.closePopup();
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
		// 内訳ポップアップ（showGroupMenu、DOM上は .monaco-workbench 直下）へフォーカスが移った
		// ときも「外へ出た」ことになってしまうが、これはフライアウト内のボタンを押して開いた
		// 正常系の遷移なので巻き戻さない。
		this.contentStore.add(dom.addDisposableListener(collapsedWrap, 'focusout', e => {
			if (collapsedWrap.contains(e.relatedTarget as Node | null) || this.popupAnchor !== undefined) {
				return;
			}
			flyout.scrollLeft = 0;
		}));

		// 同名フォルダが user/workspace の両方にあると、見た目だけでは別のフォルダだと分からない。
		// 同じ folder 名を持つグループが2つ以上あるときだけ、スコープの区別語を付ける。
		const folderLabelCounts = new Map<string, number>();
		for (const group of groups) {
			if (group.folderLabel !== undefined) {
				folderLabelCounts.set(group.folderLabel, (folderLabelCounts.get(group.folderLabel) ?? 0) + 1);
			}
		}
		for (const group of groups) {
			const folderLabel = group.folderLabel !== undefined && (folderLabelCounts.get(group.folderLabel) ?? 0) > 1
				? strFolderLabelWithScope(group.folderLabel, this.folderScopeLabel(group.presets[0]))
				: group.folderLabel;
			// キーは表示用に飾る前の生のフォルダ名から作る（同名フォルダが増減してスコープの区別語が
			// 付いたり消えたりしても、覚えた表示設定が別物扱いにならないようにする）。
			const folderKey = group.folderLabel !== undefined
				? paradisPresetFolderKey(group.presets[0], group.folderLabel)
				: undefined;
			const options = { folderLabel, folderKey };
			this.renderItem(fullEl, group.presets, qualifiers, options);
			this.renderItem(flyout, group.presets, qualifiers, options);
		}

		container.classList.toggle('is-collapsed', this.collapsed);
		this.measureFullNaturalWidth();
		this.evaluateCollapse();
	}

	/**
	 * フォルダの区別語（同名フォルダが2つ以上あるときだけ使う）。ユーザー設定由来は「ユーザー」で
	 * 固定してよいが、workspace 由来は `source` だけでは区別できない——異なる2つのリポジトリに
	 * 同名フォルダがあると、どちらも「リポジトリ」になってしまう。その場合はリポジトリのフォルダ名
	 * （sourceUri の basename）を使う。
	 */
	private folderScopeLabel(preset: IParadisResolvedPreset): string {
		if (preset.source !== 'workspace') {
			return STR_FOLDER_SCOPE_USER;
		}
		// preset.sourceUri は .paracode.json 自身の URI なので、そのままの basename は常に
		// 同じファイル名（.paracode.json）になり、複数リポジトリを区別できない。1段上（親フォルダ、
		// ＝リポジトリのルート）の basename を使う。
		return preset.sourceUri ? basename(dirname(preset.sourceUri)) : STR_FOLDER_SCOPE_WORKSPACE;
	}

	private renderItem(target: HTMLElement, group: readonly IParadisResolvedPreset[], qualifiers: Map<string, string>, options?: { readonly folderLabel?: string; readonly folderKey?: string }): void {
		const preset = group[0];
		const btn = dom.append(target, $('button.paradis-preset-cluster-item')) as HTMLButtonElement;
		btn.type = 'button';
		const folderLabel = options?.folderLabel;

		// フォルダ丸ごと（folderLabel あり）と、同名プリセットが複数（group.length > 1）は
		// 同じ描画パターン（バッジ相当のツールチップ＋クリックでメニュー）を使う。
		if (folderLabel !== undefined || group.length > 1) {
			const iconId = folderLabel !== undefined ? 'folder' : (preset.icon ?? 'play');
			const groupTitle = strPresetGroupTitle(folderLabel ?? preset.name.trim(), group.length);
			// フォルダは既定でアイコンのみ（ボタン数が増えてもタブ側を圧迫しない）。名前も出すかは
			// フォルダごとに右クリックで選べる（showHideMenu の STR_SHOW_FOLDER_LABEL）。
			const showFolderLabel = folderLabel !== undefined
				&& options?.folderKey !== undefined
				&& this.presetService.isFolderLabelShown(options.folderKey);
			if (showFolderLabel) {
				const label = dom.append(btn, $('span.paradis-preset-cluster-item-label'));
				dom.reset(label, ...renderLabelWithIcons(`$(${iconId}) ${folderLabel}`));
			} else {
				dom.append(btn, $('span.paradis-preset-cluster-item-icon')).classList.add(...ThemeIcon.asClassNameArray(ThemeIcon.fromId(iconId)));
			}
			btn.setAttribute('aria-label', groupTitle);
			btn.setAttribute('aria-haspopup', 'true');
			btn.setAttribute('aria-expanded', 'false');
			const hover = this.contentStore.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), btn, ''));
			hover.update(groupTitle);
			this.contentStore.add(dom.addDisposableListener(btn, 'click', e => {
				dom.EventHelper.stop(e, true);
				this.showGroupMenu(btn, group, qualifiers);
			}));
			this.contentStore.add(dom.addDisposableListener(btn, 'contextmenu', e => {
				dom.EventHelper.stop(e, true);
				this.showHideMenu(btn, group, qualifiers, options?.folderKey);
			}));
			return;
		}

		const iconId = preset.icon ?? 'play';

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

	/**
	 * フォルダ／同名まとめの内訳を出す。あえて `IContextMenuService` を使わず、ここだけ自前の
	 * HTML/CSS ポップアップにしている（クラス冒頭コメントと {@link popupStore} 参照）。
	 * 同じボタンを連打すると開閉をトグルし、別のボタンを押すと張り替える。
	 *
	 * DOM 上は `.monaco-workbench` 直下（アンカーからは離れた位置）に置くため、Tab キーでは
	 * 辿り着けない——`IContextMenuService` が持っていた「矢印キーで操作できる」を失わないよう、
	 * 開いた瞬間に先頭項目へフォーカスを移し、↑↓/Home/End で項目間を移動できるようにしている。
	 */
	private showGroupMenu(anchor: HTMLElement, group: readonly IParadisResolvedPreset[], qualifiers: Map<string, string>): void {
		const reopening = this.popupAnchor === anchor;
		this.closePopup();
		if (reopening) {
			return;
		}

		// 描画先は必ず .monaco-workbench の内側にする。body 直下に置くと、このポップアップの
		// CSS（.monaco-workbench を前置したセレクタ）が一切マッチせず、位置決め・見た目が
		// すべて崩れる（body は .monaco-workbench の祖先ではなく子）。念のため見つからない場合は
		// document.body へ逃がす（＝機能自体は動くが見た目は保証しない）。
		const win = dom.getWindow(anchor);
		const host = anchor.closest<HTMLElement>('.monaco-workbench') ?? win.document.body;

		const store = new DisposableStore();
		this.popupStore.value = store;
		this.popupAnchor = anchor;

		// aria-haspopup は renderItem 側で静的に付与済み（初回フォーカス時から「開くボタン」と
		// 分かるように）。ここでは開閉に応じた aria-expanded の切り替えだけ担当する。
		anchor.setAttribute('aria-expanded', 'true');
		store.add(toDisposable(() => anchor.setAttribute('aria-expanded', 'false')));

		const popup = dom.append(host, $('.paradis-preset-cluster-popup'));
		popup.setAttribute('role', 'menu');
		const anchorLabel = anchor.getAttribute('aria-label');
		if (anchorLabel) {
			popup.setAttribute('aria-label', anchorLabel);
		}
		store.add(toDisposable(() => {
			popup.remove();
			this.popupAnchor = undefined;
		}));

		const items: HTMLButtonElement[] = [];
		for (const preset of group) {
			const item = dom.append(popup, $('button.paradis-preset-cluster-popup-item')) as HTMLButtonElement;
			item.type = 'button';
			item.setAttribute('role', 'menuitem');
			items.push(item);
			const iconId = preset.icon ?? 'play';
			dom.append(item, $('span.paradis-preset-cluster-popup-item-icon')).classList.add(...ThemeIcon.asClassNameArray(ThemeIcon.fromId(iconId)));
			const qualifier = qualifiers.get(preset.key);
			dom.append(item, $('span.paradis-preset-cluster-popup-item-label')).textContent = qualifier ? `${preset.name} — ${qualifier}` : preset.name;
			store.add(dom.addDisposableListener(item, 'click', e => {
				dom.EventHelper.stop(e, true);
				this.closePopup();
				this.presetService.runPreset(preset).catch(error => this.notificationService.error(strRunFailed(preset.name, toErrorMessage(error))));
			}));
		}

		this.positionPopup(anchor, popup);
		items[0]?.focus();

		store.add(dom.addDisposableListener(popup, 'keydown', e => {
			// フォーカスは常にこの popup 内の項目にある（keydown はここに委譲されているため）。
			// dom.getActiveElement() 経由だと補助ウィンドウでの realm/フォーカス判定に左右されうるが、
			// e.target なら発火元そのものなので確実。
			const currentIndex = items.indexOf(e.target as HTMLButtonElement);
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				dom.EventHelper.stop(e, true);
				const delta = e.key === 'ArrowDown' ? 1 : -1;
				const base = currentIndex >= 0 ? currentIndex : 0;
				items[(base + delta + items.length) % items.length]?.focus();
			} else if (e.key === 'Home') {
				dom.EventHelper.stop(e, true);
				items[0]?.focus();
			} else if (e.key === 'End') {
				dom.EventHelper.stop(e, true);
				items[items.length - 1]?.focus();
			} else if (e.key === 'Tab') {
				// roving tabindex は実装していない（項目は既定の tabindex=0 のまま）ので、Tab を
				// そのまま通すと DOM 順で workbench の末尾へ飛び、ポップアップだけ開いたまま残る。
				// メニューとしての慣行どおり、Tab はメニューを閉じてアンカーへフォーカスを戻す。
				dom.EventHelper.stop(e, true);
				this.closePopup();
				if (anchor.isConnected) {
					anchor.focus();
				}
			}
		}));
		// Escape はキャプチャ段階で拾う。フォーカスがポップアップではなくターミナル本体（xterm）に
		// 残っている状態で開かれることもあり、バブル段階だと ESC が先にシェル/TUI（Claude Code や
		// Codex 等）へ渡ってから閉じてしまう——キャプチャなら常にここで先取りできる。
		store.add(dom.addDisposableListener(win, 'keydown', e => {
			if (e.key === 'Escape') {
				dom.EventHelper.stop(e, true);
				this.closePopup();
				// rebuildContent や折りたたみでこの anchor 自体が既に取り外されている場合、
				// focus() は無言で失敗するだけなので isConnected を確認してから戻す。
				if (anchor.isConnected) {
					anchor.focus();
				}
			}
		}, true));
		// click ハンドラ経由で開いているため、開いた瞬間の mousedown は既にバブリングを終えており
		// 「開いたその場で即座に外側クリック扱いされて閉じる」ことは起きない。それでも1フレーム
		// 遅らせておくのは、ブラウザ実装差やイベント順の将来変化に対する保険（実害はほぼ無い）。
		store.add(dom.scheduleAtNextAnimationFrame(win, () => {
			store.add(dom.addDisposableListener(win.document, 'mousedown', e => {
				const target = e.target as Node | null;
				if (target && !popup.contains(target) && !anchor.contains(target)) {
					this.closePopup();
				}
			}, true));
		}));
		// フォルダボタンがホバー展開のフライアウト（.paradis-preset-cluster-flyout）内にある場合、
		// このポップアップはフライアウトの外（下）に出るため、マウスをポップアップへ動かした瞬間に
		// collapsedWrap の mouseleave が発火し、HOVER_CLOSE_DELAY_MS 後にフライアウトごと閉じてしまう
		// （closeScheduler のコールバックが this.closePopup() も呼ぶため、カーソルの下でポップアップが
		// 消える）。ポップアップの上に居る間は、フライアウトの閉じ猶予タイマーを止めておく。
		if (this.closeScheduler && this.collapsedWrap?.contains(anchor)) {
			const closeScheduler = this.closeScheduler;
			closeScheduler.cancel();
			store.add(dom.addDisposableListener(popup, 'mouseenter', () => closeScheduler.cancel()));
			store.add(dom.addDisposableListener(popup, 'mouseleave', () => closeScheduler.schedule()));
		}
		// ウィンドウのリサイズ・別ウィンドウへのフォーカス移動でも、追従させるより単純に閉じる方が
		// 破綻しない（.paradis-preset-cluster-flyout もスクロール・リサイズには追従しない設計）。
		store.add(dom.addDisposableListener(win, 'resize', () => this.closePopup()));
		store.add(dom.addDisposableListener(win, 'blur', () => this.closePopup()));
	}

	/** 開いているポップアップを閉じる（無ければ何もしない）。 */
	private closePopup(): void {
		this.popupStore.clear();
		this.popupAnchor = undefined;
	}

	/**
	 * ポップアップをアンカー（クリックされたボタン）の直下、右端を揃えて配置する。ツールバーの
	 * 右寄りのボタンほど右端に近いため、右揃えを既定にしつつ、画面端からはみ出す場合はクランプする。
	 * ターミナルタブバーは下部パネルに置かれるのが既定で画面下端に近いため、下方向に収まらない
	 * ときはアンカーの上側へ反転する（CSS 側の max-height/overflow-y と合わせて、項目数が多い
	 * フォルダでも必ず操作できる範囲に収める）。
	 */
	private positionPopup(anchor: HTMLElement, popup: HTMLElement): void {
		const win = dom.getWindow(anchor);
		const anchorRect = anchor.getBoundingClientRect();
		const popupRect = popup.getBoundingClientRect();
		const margin = 4;

		let left = anchorRect.right - popupRect.width;
		left = Math.max(margin, Math.min(left, win.innerWidth - popupRect.width - margin));

		let top = anchorRect.bottom + margin;
		if (top + popupRect.height > win.innerHeight - margin) {
			top = Math.max(margin, anchorRect.top - margin - popupRect.height);
		}

		popup.style.top = `${Math.round(top)}px`;
		popup.style.left = `${Math.round(left)}px`;
	}

	/**
	 * 右クリックで「非表示にする」を選べるメニュー。以前の実装（プリセットごとに個別の
	 * MenuItemAction を登録していた頃）は、VS Code 標準のツールバー右クリック「Hide '<名前>'」が
	 * プリセット単位で独立して効いていた。今はすべてのピン留めプリセットが1個の合成アクションへ
	 * まとまっているため、その標準機能は「クラスター全体を1項目として隠す」ことしかできない
	 * （個々のプリセット単位の表示/非表示切り替えができなくなる）。同等の操作をアプリ側の
	 * `pinned` フィールド（user ソース）または、このマシンだけの非表示台帳（workspace ソース）
	 * 経由で再現する（実際の分岐は {@link hidePreset} 参照）。
	 *
	 * `showGroupMenu` と違い、こちらは意図的に `IContextMenuService`（ビルド種別・
	 * `window.menuStyle` 次第でネイティブメニューになりうる）のまま残している。使用頻度が
	 * 低い右クリック操作であることに加え、標準メニューが持つキーボード操作・破棄確認的な
	 * 挙動を自前実装で作り直すコストに見合わないため。直し忘れではなく見送り。
	 */
	private showHideMenu(anchor: HTMLElement, presets: readonly IParadisResolvedPreset[], qualifiers: Map<string, string>, folderKey?: string): void {
		const actions: IAction[] = [];
		// フォルダボタンから開いたときだけ、そのフォルダの名前表示を切り替えるチェック項目を先頭に出す。
		if (folderKey !== undefined) {
			const shown = this.presetService.isFolderLabelShown(folderKey);
			actions.push(toAction({
				id: 'paradis.presetCluster.toggleFolderLabel',
				label: STR_SHOW_FOLDER_LABEL,
				checked: shown,
				run: () => this.presetService.setFolderLabelShown(folderKey, !shown),
			}));
			actions.push(new Separator());
		}
		actions.push(...presets.map(preset => toAction({
			id: `paradis.presetCluster.hide.${preset.key}`,
			label: strHideLabel(preset.name, qualifiers.get(preset.key)),
			run: () => this.hidePreset(preset),
		})));
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
		// 折りたたみ状態が切り替わると、展開表示側・折りたたみ側のどちらか一方が display:none に
		// なりアンカーごと消える。内訳ポップアップを開いたまま切り替わると、宙に浮いたまま
		// 残ってしまうので閉じておく。
		this.closePopup();
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
