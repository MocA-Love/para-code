/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの倍率を、URL バーに出しっぱなしにする。
//
// upstream は倍率を変えた瞬間だけ URL バーの脇に 750ms 出して消す (BrowserZoomPill)。
// 押せず、消えたあとは今の倍率を確かめる手段が無い。倍率はホストごとに記憶されるので、
// 自分で変えた覚えがなくても既定と違うことがあり、そのままだとページ側のレイアウト崩れと
// 見分けがつかない。
//
// upstream のファイルには触らず、公開されている拡張点だけで足している:
//  - BrowserEditor.registerContribution() で contribution を登録
//  - BrowserWidgetLocation.PostUrl (URL ボックス内の右端) へウィジェットを1つ出す
//  - 倍率の増減は BrowserEditorZoomSupport へ委譲する (後述)
// 一瞬だけ出る upstream のピルは、これと二重に見えるので CSS 側で隠している
// (media/paradisBrowserZoomIndicator.css)。
//
// なお Agent Sessions ウィンドウは別エントリ (sessions.desktop.main.ts) で、この集約 import を
// 読まない。あちらではこれまでどおりピルのままになる (CSS も読まれないので二重にはならない)。

import './media/paradisBrowserZoomIndicator.css';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { browserZoomFactors, browserZoomLabel } from '../../../../platform/browserView/common/browserView.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IBrowserZoomService } from '../../../../workbench/contrib/browserView/common/browserZoomService.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, IBrowserEditorWidget } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { BrowserEditorZoomSupport } from '../../../../workbench/contrib/browserView/electron-browser/features/browserEditorZoomFeature.js';

/**
 * URL ボックス内での並び順。
 *
 * 同じ入れ物には共有トグル (50)・ブックマークの星 (60、フォーク独自の bookmark bar 機能。
 * upstream のお気に入りは無効化済み)・タブ pill (100) が入っていて、狭いときに刈られるのは
 * 右端から。倍率は「見えていると助かる」だけの情報なので、他のボタンより後ろへ置き、詰まった
 * ときに先に諦めるのはこちらにする。
 */
const WIDGET_ORDER = 90;

/** ± ボタン1つ分。端に着いたときは、理由の入った文言へ差し替える。 */
interface IStepButton {
	readonly element: HTMLButtonElement;
	readonly hover: IManagedHover;
	readonly label: string;
	readonly atEndLabel: string;
}

/**
 * URL ボックスに常設する倍率のステッパー（− / 倍率 / ＋）。
 *
 * 数字そのものがボタンで、押すと既定の倍率へ戻す。「既定」は 100% とは限らない ——
 * 設定 `workbench.browser.pageZoom` の既定値は「ウィンドウに合わせる」で、アプリの UI 倍率を
 * 上げている人の既定は 110% や 120% になる。100% を決め打ちにすると、その人には既定の
 * ページでも倍率が強調表示され続けてしまう (この機能が消したかった誤解をそのまま作る)。
 */
export class ParadisBrowserZoomIndicator extends BrowserEditorContribution {

	private readonly element: HTMLElement;
	private readonly zoomOutButton: IStepButton;
	private readonly zoomInButton: IStepButton;
	private readonly valueButton: HTMLButtonElement;
	/** 数字のツールチップ。既定の倍率が変わると文言も変わるので参照を持つ。 */
	private readonly valueHover: IManagedHover;

	constructor(
		editor: BrowserEditor,
		@IHoverService private readonly hoverService: IHoverService,
		@IBrowserZoomService private readonly browserZoomService: IBrowserZoomService,
	) {
		super(editor);

		this.element = $('.paradis-browser-zoom-stepper');
		this.zoomOutButton = this.createButton(
			localize('paradis.browserZoom.out', "縮小"),
			localize('paradis.browserZoom.outAtEnd', "縮小（これ以上小さくできません）"),
			'−',
			support => support.zoomOut(),
		);
		this.valueButton = append(this.element, $<HTMLButtonElement>('button.paradis-browser-zoom-value'));
		this.valueHover = this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.valueButton, ''));
		this._register(addDisposableListener(this.valueButton, EventType.CLICK, () => {
			this.run(support => support.resetZoom());
		}));
		this.zoomInButton = this.createButton(
			localize('paradis.browserZoom.in', "拡大"),
			localize('paradis.browserZoom.inAtEnd', "拡大（これ以上大きくできません）"),
			'＋',
			support => support.zoomIn(),
		);

		// 既定の倍率は「ウィンドウに合わせる」ことがあり、ウィンドウの倍率や設定を変えると
		// ページ側の倍率が動かないまま既定だけがずれる。淡色表示と文言を追従させるため、
		// モデルの変化 (onModelAttached) とは別にこちらも購読する。
		this._register(this.browserZoomService.onDidChangeZoom(() => this.render(this.editor.model)));

		this.render(undefined);
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [{ location: BrowserWidgetLocation.PostUrl, element: this.element, order: WIDGET_ORDER }];
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		store.add(model.onDidChangeZoom(() => this.render(model)));
		this.render(model);
	}

	override onModelDetached(): void {
		this.render(undefined);
	}

	/**
	 * 倍率の増減は upstream の contribution へ通す。
	 *
	 * `model.zoomIn()` を直に叩くと、そこに付いている読み上げ (accessibilityService.status) と
	 * コンテキストキーの更新を素通りしてしまい、クリックで変えたときだけ何もアナウンス
	 * されなくなる。副作用は一瞬のピル表示だけで、それは CSS で隠してある。
	 */
	private run(action: (support: BrowserEditorZoomSupport) => Promise<void>): void {
		const support = this.editor.getContribution(BrowserEditorZoomSupport);
		if (support) {
			action(support).catch(error => {
				reportParadisDiagnosticError('owned', 'browser-zoom-indicator', 'action-failed', error);
				onUnexpectedError(error);
			});
		}
	}

	private createButton(label: string, atEndLabel: string, glyph: string, action: (support: BrowserEditorZoomSupport) => Promise<void>): IStepButton {
		const element = append(this.element, $<HTMLButtonElement>('button.paradis-browser-zoom-step'));
		element.textContent = glyph;
		const hover = this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), element, label));
		this._register(addDisposableListener(element, EventType.CLICK, () => {
			if (element.getAttribute('aria-disabled') !== 'true') {
				this.run(action);
			}
		}));
		return { element, hover, label, atEndLabel };
	}

	private render(model: IBrowserViewModel | undefined): void {
		const defaultFactor = browserZoomFactors[this.browserZoomService.getEffectiveZoomIndex(undefined, false)];
		const factor = model?.zoomFactor ?? defaultFactor;
		const text = browserZoomLabel(factor);
		const isDefault = factor === defaultFactor;

		this.valueButton.textContent = text;
		// 既定のときは色を落とす。常設なので、意味のない数字が視線を取らないようにする。
		this.valueButton.classList.toggle('is-default', isDefault);
		const resetLabel = localize('paradis.browserZoom.reset', "既定の倍率（{0}）に戻す", browserZoomLabel(defaultFactor));
		this.valueButton.setAttribute('aria-label', localize('paradis.browserZoom.value', "ページの倍率 {0} — {1}", text, resetLabel));
		this.valueHover.update(resetLabel);

		// 端まで来たボタンは押しても動かない。disabled にするとホバーも出なくなり理由が伝わら
		// ないので、aria-disabled と見た目で表し、文言の方に理由を入れる
		// (クリックは createButton 側で弾く)。
		this.setEnabled(this.zoomOutButton, model?.canZoomOut !== false);
		this.setEnabled(this.zoomInButton, model?.canZoomIn !== false);
		// ページが無い間 (起動直後・エラー画面) も枠は残す。display を切ると URL バーの高さが
		// その瞬間だけ変わり、ナビバーがガタつく。
		this.element.classList.toggle('is-detached', model === undefined);
	}

	private setEnabled(button: IStepButton, enabled: boolean): void {
		const label = enabled ? button.label : button.atEndLabel;
		button.element.setAttribute('aria-disabled', String(!enabled));
		button.element.setAttribute('aria-label', label);
		button.element.classList.toggle('is-disabled', !enabled);
		button.hover.update(label);
	}
}

BrowserEditor.registerContribution(ParadisBrowserZoomIndicator);
