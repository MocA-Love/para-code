/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { DisposableResizeObserver, getWindow, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import './media/paradisTitlebarFit.css';

/**
 * 幅の段。タイトルバー自身の幅がこの値以下になったら `paradis-fit-<値>` をタイトルバーに付け、
 * CSS (paradisTitlebarFit.css) がそのクラスを見て優先度の低い部品から畳む。
 */
const FIT_STEPS = [1400, 1200, 1000] as const;

/**
 * 測って畳む段の数。幅の段で足りないとき (利用リミットの輪はアカウントの数で幅が変わる)、窓をつかんで
 * ドラッグできる空きが {@link MIN_DRAG_GAP} に満たないあいだ、`paradis-fold-1` から順に足していく。
 * 段の中身は CSS (paradisTitlebarFit.css) にあり、どれも幅の段と同じ「優先度の低い順」:
 * 1 エージェント一覧・ブラウザ一覧の文字、2 使用率の文字、3 知らせの無いサービスの項目、4 利用リミットの余裕のある輪
 */
const FOLD_LEVELS = 4;

/** タイトルバーに残す、ドラッグできるひと続きの空きの幅 (px)。 */
const MIN_DRAG_GAP = 40;

/** カスタムメニューバーがタイトルバー左側に見えているあいだ付けるクラス。 */
const MENUBAR_VISIBLE_CLASS = 'paradis-fit-menubar-visible';

/** テストで差し替える依存。既定は要素が属するウィンドウの `ResizeObserver`。 */
export interface IParadisTitlebarFitOptions {
	readonly resizeObserverCtor?: typeof ResizeObserver;
	/** 中身の変化をまとめて走らせる先。既定は要素が属するウィンドウの次のフレーム。 */
	readonly scheduleFrame?: (runner: () => void) => IDisposable;
	/** 畳む段を測り直したとき呼ぶ (テストで測り直しの回数を数える)。 */
	readonly onDidMeasureFold?: () => void;
}

/** titlebarPart.ts の PARA-PATCH 点 (NativeTitlebarPart.createContentArea) から呼ばれるファクトリ。 */
export function createParadisTitlebarFit(rootContainer: HTMLElement, leftContent: HTMLElement, options?: IParadisTitlebarFitOptions): IDisposable {
	return new ParadisTitlebarFit(rootContainer, leftContent, options);
}

/**
 * タイトルバーに fork が足した部品 (左: CPU/RAM・リミット・サービス状態・ポート、右: エージェント一覧・
 * ブラウザ一覧) を、狭いウィンドウでも中央のコマンドセンターに重ねないための状態をクラスで出す。
 *
 * - 幅はウィンドウのメディアクエリではなくタイトルバー自身の幅で測る。ズームアウトするとタイトルバーは
 *   `counter-zoom` で等倍に戻して描かれ、ウィンドウの CSS px とタイトルバー内の px がずれるため
 * - カスタムメニューバー (Windows/Linux) が左側に見えているかも出す。見えているときは左側を内容の幅に
 *   固定しない (メニューバーは自分の幅を測ってメニューを畳むので、固定すると畳めなくなる)。`.menubar` は
 *   メニューを隠す設定でも要素としては残るため、要素の有無ではなく実際の表示を見る
 */
class ParadisTitlebarFit extends Disposable {

	private readonly resizeObserver: DisposableResizeObserver;
	private readonly menubarObservation = this._register(new MutableDisposable<IDisposable>());
	private observedMenubar: HTMLElement | undefined;
	/** 中身の変化をまとめて次のフレームで 1 回だけ update する予約。 */
	private readonly pendingUpdate = this._register(new MutableDisposable<IDisposable>());
	/** 前に畳む段を測ったときのタイトルバーの形 ({@link foldSignature})。同じなら測り直さない。 */
	private lastFoldSignature: string | undefined;

	constructor(
		private readonly rootContainer: HTMLElement,
		private readonly leftContent: HTMLElement,
		private readonly options?: IParadisTitlebarFitOptions,
	) {
		super();

		const targetWindow = getWindow(rootContainer);
		// 最初の段は ResizeObserver の初回の通知で決まる (observe した直後に必ず1回届く)
		this.resizeObserver = this._register(new DisposableResizeObserver('ParadisTitlebarFit.width', () => this.update(), targetWindow, options));
		this._register(this.resizeObserver.observe(rootContainer));

		// メニューバーは設定の変更で作り直される。付け替わった要素を追いかけて、表示の切り替え
		// (display: none ⇄ flex) も ResizeObserver で拾う。左側の部品の `active` (パネルを開いている)
		// の付け外しも見て、閉じたときに止めていた段を追いつかせる。使用率の文字は毎秒書き換わるので、
		// 変化は次のフレームで 1 回にまとめる (幅が前と同じなら測り直しも飛ばす。updateFoldLevel)
		const mutationObserver = new targetWindow.MutationObserver(() => this.scheduleUpdate());
		this._register(toDisposable(() => mutationObserver.disconnect()));
		mutationObserver.observe(leftContent, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
	}

	private scheduleUpdate(): void {
		if (this.pendingUpdate.value) {
			return;
		}
		const runner = () => {
			this.pendingUpdate.clear();
			this.update();
		};
		this.pendingUpdate.value = this.options?.scheduleFrame ? this.options.scheduleFrame(runner) : scheduleAtNextAnimationFrame(getWindow(this.rootContainer), runner);
	}

	override dispose(): void {
		for (const step of FIT_STEPS) {
			this.rootContainer.classList.remove(`paradis-fit-${step}`);
		}
		this.setFoldLevel(0);
		this.rootContainer.classList.remove(MENUBAR_VISIBLE_CLASS);
		super.dispose();
	}

	private update(): void {
		const menubar = this.findMenubar();
		if (menubar !== this.observedMenubar) {
			this.observedMenubar = menubar;
			this.menubarObservation.value = menubar ? this.resizeObserver.observe(menubar) : undefined;
		}
		this.rootContainer.classList.toggle(MENUBAR_VISIBLE_CLASS, !!menubar && menubar.offsetWidth > 0);

		// clientWidth はタイトルバー自身の座標 (counter-zoom の中の px) で返る。中の部品の幅と同じ単位
		const width = this.rootContainer.clientWidth;
		if (width === 0) {
			return; // 非表示 (全画面の一部状態など) のあいだは段を変えない
		}
		if (this.hasOpenPanel()) {
			// 左側のパネルやポップオーバーは開いた時点のボタンの位置に置かれる。開いているあいだに段を
			// 変えると、そのボタンが隠れたり隣が畳まれてずれたりしてパネルだけが取り残されるので止める
			return;
		}
		for (const step of FIT_STEPS) {
			this.rootContainer.classList.toggle(`paradis-fit-${step}`, width <= step);
		}
		this.updateFoldLevel();
	}

	/**
	 * 幅の段を当てたうえで、ドラッグできる空きが足りなければ畳む段を 1 つずつ上げて測り直す。毎回 0 から
	 * 積み上げ、描画の前に同期で測るのでちらつかない。クラスはタイトルバーの外枠 (rootContainer) にだけ
	 * 付ける (左側の中身のクラスを変えると MutationObserver がまた update を呼ぶ)。全部畳んでも足りない
	 * 狭さでは、左側を内容の幅に固定する規則 (paradisTitlebarFit.css の 1) が重なりだけを防ぐ。
	 * メニューバーが見えているあいだは左側をメニューバーが測って畳むので、ここでは畳まない。
	 */
	private updateFoldLevel(): void {
		// 外枠の幅と左側の子 (数・class・今の段での幅) が前に測ったときと同じなら、空きも同じなので測らない
		// (使用率の文字が毎秒変わっても、幅が変わらなければここで止まる)
		if (this.foldSignature() === this.lastFoldSignature) {
			return;
		}
		this.setFoldLevel(0);
		if (!this.rootContainer.classList.contains(MENUBAR_VISIBLE_CLASS)) {
			for (let level = 1; level <= FOLD_LEVELS && this.largestDragGap() < MIN_DRAG_GAP; level++) {
				this.setFoldLevel(level);
			}
		}
		this.lastFoldSignature = this.foldSignature();
		this.options?.onDidMeasureFold?.();
	}

	/** 畳む段の答えを変えうるもの: 外枠の幅、メニューバーの表示、左側の子の数・class・幅 (今の段のまま)。 */
	private foldSignature(): string {
		const parts = [String(this.rootContainer.clientWidth), String(this.rootContainer.classList.contains(MENUBAR_VISIBLE_CLASS))];
		for (const child of this.leftContent.children) {
			parts.push(`${child.className}:${(child as HTMLElement).offsetWidth}`);
		}
		return parts.join('|');
	}

	private setFoldLevel(level: number): void {
		for (let index = 1; index <= FOLD_LEVELS; index++) {
			this.rootContainer.classList.toggle(`paradis-fold-${index}`, index <= level);
		}
	}

	/**
	 * タイトルバーの中で、押せる部品 (左側と右側の子、中央のコマンドセンター) に挟まれたいちばん広い空きの幅。
	 * 空きはタイトルバー全体の drag 領域なので、そのままつかんで窓を動かせる。左端の部品より左は数えない
	 * (macOS では信号機のボタンがあり、使用率の項目の margin-left はそれを避けるための余白)。右端は右側の
	 * padding の内側まで数える。
	 */
	private largestDragGap(): number {
		const left = this.leftContent;
		const center = this.childWithClass(this.rootContainer, 'titlebar-center');
		const right = this.childWithClass(this.rootContainer, 'titlebar-right');
		const spans: { start: number; end: number }[] = [];
		const addChildren = (parent: HTMLElement | undefined) => {
			for (const child of parent?.children ?? []) {
				const rect = child.getBoundingClientRect();
				if (rect.width > 0) {
					spans.push({ start: rect.left, end: rect.right });
				}
			}
		};
		addChildren(left);
		const windowTitle = center && this.childWithClass(center, 'window-title');
		const commandCenter = windowTitle && this.childWithClass(windowTitle, 'command-center');
		if (commandCenter && !commandCenter.classList.contains('hide')) {
			const rect = commandCenter.getBoundingClientRect();
			if (rect.width > 0) {
				spans.push({ start: rect.left, end: rect.right });
			}
		}
		addChildren(right);

		const targetWindow = getWindow(this.rootContainer);
		spans.sort((a, b) => a.start - b.start);
		let cursor = spans.length ? spans[0].start : left.getBoundingClientRect().left;
		const rightRect = (right ?? this.rootContainer).getBoundingClientRect();
		const end = rightRect.right - (right ? parseFloat(targetWindow.getComputedStyle(right).paddingRight) || 0 : 0);
		let largest = 0;
		for (const span of spans) {
			largest = Math.max(largest, span.start - cursor);
			cursor = Math.max(cursor, span.end);
		}
		return Math.max(largest, end - cursor);
	}

	private childWithClass(parent: HTMLElement, className: string): HTMLElement | undefined {
		for (const child of parent.children) {
			if (child.classList.contains(className)) {
				return child as HTMLElement;
			}
		}
		return undefined;
	}

	private hasOpenPanel(): boolean {
		for (const child of this.leftContent.children) {
			if (child.classList.contains('active')) {
				return true;
			}
		}
		return false;
	}

	private findMenubar(): HTMLElement | undefined {
		for (const child of this.leftContent.children) {
			if (child.classList.contains('menubar')) {
				return child as HTMLElement;
			}
		}
		return undefined;
	}
}
