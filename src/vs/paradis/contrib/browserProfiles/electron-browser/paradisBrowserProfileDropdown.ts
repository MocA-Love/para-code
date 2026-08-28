/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ナビバーのプロファイルピルから開くドロップダウン（承認済みモック 2-3.html の②）。
//
// QuickPick ではなく自前の DOM ウィジェットにしている（ユーザー判断）。その代わり、QuickPick が
// 無償で持っていたものを全部こちらで持つ必要がある:
//  - **overlayManager への登録**（`paradis-browser-profile-dropdown`）。これが無いと内蔵ブラウザの
//    ネイティブ WebContentsView の裏に隠れて何も見えない。既知の落とし穴なので必須。
//  - キーボード操作（↑↓/Home/End/Enter/Space/Esc）と Tab のフォーカストラップ
//  - 開いたら選択中の行へフォーカス、閉じたらピルへフォーカスを戻す
//  - 外側クリック・スクロール・ウィンドウリサイズで閉じる
//  - role="listbox" / role="option" / aria-selected / (ピル側の) aria-expanded
//  - 画面端でのはみ出し回避（左右クランプ + 上下反転）
// 色は `--vscode-*` トークンのみ。プロファイルの識別色だけは実データなのでそのまま塗る。

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { BrowserViewStorageScope } from '../../../../platform/browserView/common/browserView.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IParadisBrowserProfile } from '../common/paradisBrowserProfileModel.js';
import { IParadisViewSessionInfo } from '../common/paradisBrowserProfileChannel.js';
import { ParadisProfileTarget } from './paradisBrowserProfilesService.js';

const $ = dom.$;

/** ドロップダウンの幅（モック準拠）。狭いウィンドウではクランプで内側に収める。 */
const DROPDOWN_WIDTH = 340;
/** アンカー（ピル）との縦の隙間。 */
const ANCHOR_GAP = 4;
/** コンテナ端との最小マージン。 */
const EDGE_MARGIN = 8;
/** これより長く使っていないプロファイルは淡色にして「整理候補」と分かるようにする。 */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface IParadisBrowserProfileDropdownOptions {
	/** ピル。位置の基準であり、閉じたときのフォーカスの戻り先。 */
	readonly anchor: HTMLElement;
	/** 今このビューが使っているセッション。チェックマークの位置になる。 */
	readonly current: IParadisViewSessionInfo | undefined;
	readonly profiles: readonly IParadisBrowserProfile[];
	/** 今エージェントが操作中のプロファイル（補足表示に使う）。 */
	readonly agentProfileIds: ReadonlySet<string>;
	/**
	 * 名前付きプロファイルを選べるか。信頼していないワークスペースでは upstream が常に
	 * エフェメラルへ倒すので、選べないことと理由を出す。
	 */
	readonly profilesEnabled: boolean;
	readonly onSelect: (target: ParadisProfileTarget) => void;
	readonly onCreate: () => void;
	readonly onManage: () => void;
}

/** 行1つ分の内部表現。 */
interface IDropdownRow {
	readonly element: HTMLElement;
	readonly run: () => void;
}

export class ParadisBrowserProfileDropdown extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _listElement: HTMLElement;
	private readonly _rows: IDropdownRow[] = [];
	private readonly _container: HTMLElement;
	private _focusedIndex = 0;
	private _disposed = false;

	constructor(
		private readonly options: IParadisBrowserProfileDropdownOptions,
		@ILayoutService layoutService: ILayoutService,
	) {
		super();

		this._container = layoutService.activeContainer;
		this._element = $('.paradis-browser-profile-dropdown');
		this._element.tabIndex = -1;
		this._listElement = dom.append(this._element, $('.pbp-list'));
		this._listElement.setAttribute('role', 'listbox');
		this._listElement.setAttribute('aria-label', localize('paradis.browserProfiles.dropdown.label', "ブラウザのプロファイル"));

		this._renderBuiltInScopes();
		this._renderProfiles();
		this._renderFooter();

		this._container.appendChild(this._element);
		this.options.anchor.setAttribute('aria-expanded', 'true');

		this._layout();
		this._registerListeners();
		this._focusInitialRow();
	}

	// #region 描画

	private _renderBuiltInScopes(): void {
		this._appendSeparator(localize('paradis.browserProfiles.dropdown.builtIn', "組み込みスコープ"));
		this._appendScopeRow(
			BrowserViewStorageScope.Global,
			Codicon.globe,
			localize('paradis.browserProfiles.scope.global', "グローバル"),
			localize('paradis.browserProfiles.scope.globalDetail', "すべてのワークスペースで共有される既定のセッション"),
		);
		this._appendScopeRow(
			BrowserViewStorageScope.Workspace,
			Codicon.folder,
			localize('paradis.browserProfiles.scope.workspace', "ワークスペース"),
			localize('paradis.browserProfiles.scope.workspaceDetail', "この Para Code ワークスペースだけで共有"),
		);
		this._appendScopeRow(
			BrowserViewStorageScope.Ephemeral,
			Codicon.history,
			localize('paradis.browserProfiles.scope.ephemeral', "エフェメラル"),
			localize('paradis.browserProfiles.scope.ephemeralDetail', "タブを閉じると Cookie ごと破棄される使い捨てセッション"),
		);
	}

	private _renderProfiles(): void {
		this._appendSeparator(localize('paradis.browserProfiles.dropdown.named', "名前付きプロファイル"));

		if (!this.options.profilesEnabled) {
			// 信頼していないワークスペース。選べない理由を出す（黙って空にすると、作った
			// はずのプロファイルが消えたように見える）。
			const notice = dom.append(this._listElement, $('.pbp-notice'));
			notice.textContent = localize(
				'paradis.browserProfiles.dropdown.untrusted',
				"このワークスペースを信頼していないため、ログイン状態を保存するプロファイルは使えません。ワークスペースを信頼すると使えるようになります。",
			);
			return;
		}

		if (this.options.profiles.length === 0) {
			const notice = dom.append(this._listElement, $('.pbp-notice'));
			notice.textContent = localize(
				'paradis.browserProfiles.dropdown.empty',
				"まだプロファイルがありません。作成して一度ログインすると、次回から自動でログイン状態が戻ります。",
			);
			return;
		}

		const now = Date.now();
		for (const profile of this.options.profiles) {
			const selected = this.options.current?.profileId === profile.id;
			const stale = now - profile.lastUsedAt > STALE_AFTER_MS;
			const details = [localize('paradis.browserProfiles.dropdown.lastUsed', "最終利用: {0}", fromNow(profile.lastUsedAt, true))];
			if (this.options.agentProfileIds.has(profile.id)) {
				details.push(localize('paradis.browserProfiles.dropdown.agentActive', "エージェントが使用中"));
			}
			const row = this._appendRow({
				selected,
				stale,
				label: profile.name,
				detail: details.join(' ・ '),
				color: profile.color,
				run: () => this.options.onSelect({ kind: 'profile', profileId: profile.id }),
			});
			row.element.setAttribute('aria-label', localize(
				'paradis.browserProfiles.dropdown.profileAria',
				"プロファイル {0}。{1}", profile.name, details.join('。'),
			));
		}
	}

	private _renderFooter(): void {
		// listbox の**外**に置く。中に入れると、選択対象でない操作行が option として数えられる。
		const footer = dom.append(this._element, $('.pbp-footer'));
		this._appendActionRow(footer, Codicon.add, localize('paradis.browserProfiles.dropdown.create', "新しいプロファイルを作成…"), () => this.options.onCreate());
		this._appendActionRow(footer, Codicon.settingsGear, localize('paradis.browserProfiles.dropdown.manage', "プロファイルを管理…"), () => this.options.onManage());
	}

	private _appendSeparator(text: string): void {
		// 見出しは listbox の子だが選択対象ではないので、支援技術からは行として見せない。
		const separator = dom.append(this._listElement, $('.pbp-separator'));
		separator.setAttribute('role', 'presentation');
		separator.textContent = text;
	}

	private _appendScopeRow(scope: BrowserViewStorageScope, icon: ThemeIcon, label: string, detail: string): void {
		this._appendRow({
			selected: this.options.current?.scope === scope,
			stale: false,
			label,
			detail,
			icon,
			run: () => this.options.onSelect({ kind: 'scope', scope }),
		});
	}

	private _appendActionRow(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => void): void {
		const element = dom.append(parent, $('button.pbp-row.pbp-action'));
		// 作成／管理は「選ぶ対象」ではなく操作なので、listbox の option にはしない
		// （role="option" なのに aria-selected を持たない行を作らない）。フッターは
		// listbox の外側にあり、キーボードでの移動だけ行と同じ扱いにしている。
		this._prepareRow(element, run, 'action');
		dom.append(element, $(`.pbp-icon${ThemeIcon.asCSSSelector(icon)}`));
		dom.append(element, $('.pbp-main')).appendChild($('.pbp-label', undefined, label));
	}

	private _appendRow(descriptor: {
		readonly selected: boolean;
		readonly stale: boolean;
		readonly label: string;
		readonly detail: string;
		readonly color?: string;
		readonly icon?: ThemeIcon;
		readonly run: () => void;
	}): IDropdownRow {
		const element = dom.append(this._listElement, $('.pbp-row'));
		element.classList.toggle('is-selected', descriptor.selected);
		element.classList.toggle('is-stale', descriptor.stale);
		const row = this._prepareRow(element, descriptor.run);
		element.setAttribute('aria-selected', String(descriptor.selected));

		if (descriptor.color) {
			const dot = dom.append(element, $('.pbp-dot'));
			// 識別色はユーザーが選んだ実データなので、テーマトークンではなくそのまま塗る。
			dot.style.backgroundColor = descriptor.color;
		} else if (descriptor.icon) {
			dom.append(element, $(`.pbp-icon${ThemeIcon.asCSSSelector(descriptor.icon)}`));
		}

		const main = dom.append(element, $('.pbp-main'));
		dom.append(main, $('.pbp-label')).textContent = descriptor.label;
		if (descriptor.detail) {
			dom.append(main, $('.pbp-detail')).textContent = descriptor.detail;
		}
		if (descriptor.selected) {
			dom.append(element, $(`.pbp-check${ThemeIcon.asCSSSelector(Codicon.check)}`));
		}
		return row;
	}

	/** 行に共通の属性・イベントを付け、行一覧へ登録する。 */
	private _prepareRow(element: HTMLElement, run: () => void, kind: 'option' | 'action' = 'option'): IDropdownRow {
		if (kind === 'option') {
			element.setAttribute('role', 'option');
		}
		element.tabIndex = -1;
		const row: IDropdownRow = { element, run };
		this._rows.push(row);
		const index = this._rows.length - 1;
		this._register(dom.addDisposableListener(element, dom.EventType.MOUSE_DOWN, event => {
			// ここで既定を止めないと、押した瞬間にフォーカスが移って外側クリック判定と競合する。
			event.preventDefault();
		}));
		this._register(dom.addDisposableListener(element, dom.EventType.CLICK, () => run()));
		this._register(dom.addDisposableListener(element, dom.EventType.MOUSE_OVER, () => this._focusRow(index, false)));
		return row;
	}

	// #endregion

	// #region 位置・イベント

	/**
	 * ピルの真下に置く。右端・下端でははみ出さないようにクランプし、下に入らないときは
	 * ピルの上へ反転する。ウィンドウが極端に狭い場合は幅もコンテナに合わせて縮める。
	 */
	private _layout(): void {
		const containerPosition = dom.getDomNodePagePosition(this._container);
		const anchorPosition = dom.getDomNodePagePosition(this.options.anchor);

		const availableWidth = Math.max(0, containerPosition.width - EDGE_MARGIN * 2);
		const width = Math.min(DROPDOWN_WIDTH, availableWidth);
		this._element.style.width = `${width}px`;

		// 縦の最大サイズを先に決めてから測る（内容が長いと反転判定が狂うため）。
		const anchorTop = anchorPosition.top - containerPosition.top;
		const anchorBottom = anchorTop + anchorPosition.height;
		const spaceBelow = containerPosition.height - anchorBottom - ANCHOR_GAP - EDGE_MARGIN;
		const spaceAbove = anchorTop - ANCHOR_GAP - EDGE_MARGIN;
		const flipUp = spaceBelow < 180 && spaceAbove > spaceBelow;
		this._element.style.maxHeight = `${Math.max(120, flipUp ? spaceAbove : spaceBelow)}px`;

		const height = this._element.offsetHeight;
		const top = flipUp
			? Math.max(EDGE_MARGIN, anchorTop - ANCHOR_GAP - height)
			: Math.min(anchorBottom + ANCHOR_GAP, Math.max(EDGE_MARGIN, containerPosition.height - EDGE_MARGIN - height));

		const anchorLeft = anchorPosition.left - containerPosition.left;
		const left = Math.min(
			Math.max(EDGE_MARGIN, anchorLeft),
			Math.max(EDGE_MARGIN, containerPosition.width - width - EDGE_MARGIN),
		);

		this._element.style.top = `${Math.round(top)}px`;
		this._element.style.left = `${Math.round(left)}px`;
	}

	private _registerListeners(): void {
		const targetWindow = dom.getWindow(this._container);

		this._register(dom.addDisposableListener(this._element, dom.EventType.KEY_DOWN, event => this._onKeyDown(event)));

		// 外側クリック。capture で拾うのは、ページ側の要素が stopPropagation しても閉じられるようにするため。
		// `instanceof Node` で判定しないのは、補助ウィンドウでは realm が違って false になり得るため
		// （その場合「外側」と誤判定して閉じてしまう）。contains() だけで見る。
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.MOUSE_DOWN, event => {
			const target = event.target as Node | null;
			if (target && (this._element.contains(target) || this.options.anchor.contains(target))) {
				return;
			}
			this.close();
		}, true));

		// スクロール・リサイズでアンカーが動くと、位置がずれたまま残る。追従させるより閉じる方が
		// 正直（QuickPick も同じ振る舞い）。
		//
		// ただし**自分のリスト自身のスクロールでは閉じない**。このドロップダウンは
		// overflow:auto = 自分がスクロールコンテナで、scroll はバブルしないが capture 段は
		// window を通るため、素朴に閉じるとホイールで即閉じる。さらに開いた直後の
		// scrollIntoView() でも発火するので、選択行が折り返しより下にあると「開いた瞬間に閉じる」。
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.SCROLL, event => {
			const target = event.target as Node | null;
			if (target && this._element.contains(target)) {
				return;
			}
			this.close();
		}, true));
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.RESIZE, () => this.close()));
		// ピルごとエディタが破棄されたら、宙に浮いたドロップダウンだけが残らないようにする。
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.BLUR, () => this.close()));
	}

	private _onKeyDown(event: KeyboardEvent): void {
		const keyboardEvent = new StandardKeyboardEvent(event);
		switch (keyboardEvent.keyCode) {
			case KeyCode.Escape:
				keyboardEvent.preventDefault();
				keyboardEvent.stopPropagation();
				this.close();
				return;
			case KeyCode.DownArrow:
				keyboardEvent.preventDefault();
				this._focusRow(this._focusedIndex + 1, true);
				return;
			case KeyCode.UpArrow:
				keyboardEvent.preventDefault();
				this._focusRow(this._focusedIndex - 1, true);
				return;
			case KeyCode.Home:
				keyboardEvent.preventDefault();
				this._focusRow(0, true);
				return;
			case KeyCode.End:
				keyboardEvent.preventDefault();
				this._focusRow(this._rows.length - 1, true);
				return;
			case KeyCode.Enter:
			case KeyCode.Space:
				keyboardEvent.preventDefault();
				this._rows[this._focusedIndex]?.run();
				return;
			case KeyCode.Tab:
				// フォーカストラップ。Tab を外へ逃がすと、ドロップダウンが開いたままワークベンチ
				// 側の要素へフォーカスが移り、閉じ方が分からなくなる。
				keyboardEvent.preventDefault();
				this._focusRow(this._focusedIndex + (keyboardEvent.shiftKey ? -1 : 1), true);
				return;
			default:
				return;
		}
	}

	/** 開いた直後のフォーカス先は「今使っているもの」。無ければ先頭。 */
	private _focusInitialRow(): void {
		const selected = this._rows.findIndex(row => row.element.classList.contains('is-selected'));
		this._focusRow(selected >= 0 ? selected : 0, true);
	}

	private _focusRow(index: number, moveFocus: boolean): void {
		if (this._rows.length === 0) {
			return;
		}
		const wrapped = ((index % this._rows.length) + this._rows.length) % this._rows.length;
		this._focusedIndex = wrapped;
		for (const [position, row] of this._rows.entries()) {
			row.element.classList.toggle('is-focused', position === wrapped);
		}
		if (moveFocus) {
			const element = this._rows[wrapped].element;
			element.focus();
			element.scrollIntoView({ block: 'nearest' });
		}
	}

	// #endregion

	close(): void {
		this.dispose();
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this.options.anchor.setAttribute('aria-expanded', 'false');
		// 閉じたらピルへフォーカスを戻す。戻さないと、キーボードだけで操作している人の
		// フォーカスが body へ落ちてナビバーへ帰れなくなる。
		if (this.options.anchor.isConnected && dom.isAncestorOfActiveElement(this._element)) {
			this.options.anchor.focus();
		}
		this._element.remove();
		super.dispose();
	}
}
