/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのエディタ1枚ぶんの Design Mode（B1）と Markup（B2）。
//
//  - Design Mode: ページの要素をクリック → コメントを入力 → 注釈トレイへ。モードは Esc か
//    ボタンでやめるまで続く（upstream の「Comment on Elements」と同じ続け方）
//  - Markup: ページのスクリーンショットに書き込み、その画像を注釈としてトレイへ
//  - 注釈トレイ: ナビバーとページの間の帯（Q60 A）。[送る] で送り先を一覧から選ぶ
//
// upstream のファイルには触らず、BrowserEditor.registerContribution() と
// BrowserWidgetLocation.Toolbar（ナビバーとページの間）だけを使う。

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, IBrowserEditorWidget } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IParadisDesignPin, IParadisPickedElement, PARADIS_DESIGN_BUDGET, paradisClipRectToViewport, paradisDesignSanitizeUrl } from '../common/paradisDesignMode.js';
import { IParadisDesignAnnotation, paradisDesignInlineText } from '../common/paradisDesignModeFormat.js';
import { IParadisDesignModeService } from './paradisDesignModeService.js';
import { ParadisDesignModeSender } from './paradisDesignModeSender.js';
import { ParadisMarkupOverlay, paradisMarkupAreaOf } from './paradisMarkupOverlay.js';

export const CONTEXT_PARADIS_DESIGN_MODE_ACTIVE = new RawContextKey<boolean>('paradisBrowserDesignModeActive', false, localize('paradis.designMode.contextActive', "内蔵ブラウザで Design Mode（要素にコメント）が有効か"));
export const CONTEXT_PARADIS_MARKUP_ACTIVE = new RawContextKey<boolean>('paradisBrowserMarkupActive', false, localize('paradis.designMode.contextMarkup', "内蔵ブラウザでスクリーンショットへ書き込み中か"));

/**
 * トレイの並び順。ナビバー（0）と upstream の検索バー・端末エミュレーションの帯より後ろ、
 * つまりページのすぐ上に置く。
 */
const TRAY_ORDER = 200;

function fullMessage(): string {
	return localize('paradis.designMode.full', "1ページに付けられる注釈は {0} 件までです。送るか消してから続けてください。", PARADIS_DESIGN_BUDGET.annotationsMaxPerPage);
}

async function validateComment(value: string): Promise<string | undefined> {
	return value.length > PARADIS_DESIGN_BUDGET.commentMaxLength
		? localize('paradis.designMode.commentTooLong', "{0} 文字までです。", PARADIS_DESIGN_BUDGET.commentMaxLength)
		: undefined;
}

function describeElement(element: IParadisPickedElement): string {
	const text = element.accessibleName || element.textSnippet;
	return text ? `${element.tagName} "${paradisDesignInlineText(text, 40)}"` : element.tagName;
}

export class ParadisDesignModeFeature extends BrowserEditorContribution {

	private readonly tray: HTMLElement;
	private readonly hint: HTMLElement;
	private readonly countButton: HTMLButtonElement;
	private readonly attachLabel: HTMLLabelElement;
	private readonly attachCheckbox: HTMLInputElement;
	private readonly attachText: HTMLElement;
	private readonly clearButton: HTMLButtonElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly stopButton: HTMLButtonElement;

	private readonly designModeActive: IContextKey<boolean>;
	private readonly markupActive: IContextKey<boolean>;
	private readonly markup = this._register(new MutableDisposable<ParadisMarkupOverlay>());
	private readonly sender: ParadisDesignModeSender;

	/** 選択の回ごとに進める。やめた後に戻ってきた古い選択結果を捨てるため。 */
	private designGeneration = 0;
	/** 選択を続けているページ（やめたら undefined）。 */
	private designPage: IBrowserViewModel | undefined;
	private sending = false;
	private trayVisible = false;

	constructor(
		editor: BrowserEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IParadisDesignModeService private readonly designModeService: IParadisDesignModeService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super(editor);
		this.designModeActive = CONTEXT_PARADIS_DESIGN_MODE_ACTIVE.bindTo(contextKeyService);
		this.markupActive = CONTEXT_PARADIS_MARKUP_ACTIVE.bindTo(contextKeyService);
		this.sender = instantiationService.createInstance(ParadisDesignModeSender);

		this.tray = $('.paradis-design-tray');
		this.tray.setAttribute('role', 'toolbar');
		this.tray.setAttribute('aria-label', localize('paradis.designMode.tray', "注釈トレイ"));
		this.tray.style.display = 'none';

		this.countButton = append(this.tray, $<HTMLButtonElement>('button.paradis-design-tray-count'));
		this.countButton.type = 'button';
		this._register(addDisposableListener(this.countButton, EventType.CLICK, () => void this.manageAnnotations()));

		this.hint = append(this.tray, $('span.paradis-design-tray-hint'));

		this.attachLabel = append(this.tray, $<HTMLLabelElement>('label.paradis-design-tray-attach'));
		this.attachCheckbox = append(this.attachLabel, $<HTMLInputElement>('input'));
		this.attachCheckbox.type = 'checkbox';
		this.attachText = append(this.attachLabel, $('span'));
		this._register(addDisposableListener(this.attachCheckbox, EventType.CHANGE, () => {
			this.designModeService.attachImages = this.attachCheckbox.checked;
		}));

		append(this.tray, $('span.paradis-design-tray-spacer'));

		this.stopButton = this.trayButton(localize('paradis.designMode.stop', "選択をやめる"), false, () => this.stopDesignMode());
		this.clearButton = this.trayButton(localize('paradis.designMode.clearAll', "すべて消す"), false, () => this.clearAnnotations());
		this.sendButton = this.trayButton(localize('paradis.designMode.send', "送る"), true, () => void this.sendAnnotations());
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [{ location: BrowserWidgetLocation.Toolbar, element: this.tray, order: TRAY_ORDER }];
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		store.add(this.designModeService.onDidChangeAnnotations(pageId => {
			if (pageId === model.id) {
				this.renderTray();
				void this.syncPins(model);
			}
		}));
		store.add(this.designModeService.onDidChangeAttachImages(() => this.renderTray()));
		// 遷移するとページの札は DOM ごと消える。読み込みが終わったら置き直す
		store.add(model.onDidChangeLoadingState(() => {
			if (!model.loading) {
				void this.syncPins(model);
			}
		}));
		// このエディタが別のページへ替わる・閉じるときは、選択と書き込みをやめる
		store.add(toDisposable(() => {
			this.stopDesignMode();
			this.markup.clear();
		}));
		this.renderTray();
		void this.syncPins(model);
	}

	override onModelDetached(): void {
		this.renderTray();
	}

	get isDesignModeActive(): boolean {
		return this.designPage !== undefined;
	}

	toggleDesignMode(): void {
		if (this.designPage) {
			this.stopDesignMode();
		} else {
			void this.startDesignMode();
		}
	}

	stopDesignMode(): void {
		const page = this.designPage;
		if (!page) {
			return;
		}
		this.designPage = undefined;
		this.designGeneration++;
		this.designModeActive.set(false);
		void this.designModeService.cancelPick(page.id);
		void this.syncPins(page);
		this.renderTray();
	}

	private async startDesignMode(): Promise<void> {
		const model = this.editor.model;
		if (!model || this.designPage) {
			return;
		}
		this.markup.clear();
		const generation = ++this.designGeneration;
		this.designPage = model;
		this.designModeActive.set(true);
		this.renderTray();
		try {
			while (this.designGeneration === generation && this.editor.model === model) {
				if (this.designModeService.getAnnotations(model.id).length >= PARADIS_DESIGN_BUDGET.annotationsMaxPerPage) {
					this.notificationService.info(fullMessage());
					break;
				}
				const result = await this.designModeService.pickElement(model.id);
				if (this.designGeneration !== generation || result.kind === 'cancelled') {
					break;
				}
				await this.addElementAnnotation(model, result.element);
			}
		} catch (error) {
			this.logService.warn('[ParadisDesignMode] element picking failed', error);
			this.notificationService.error(localize('paradis.designMode.pickFailed', "要素を選べませんでした: {0}", toErrorMessage(error)));
		} finally {
			if (this.designGeneration === generation) {
				this.stopDesignMode();
			}
		}
	}

	private async addElementAnnotation(model: IBrowserViewModel, element: IParadisPickedElement): Promise<void> {
		// コメント欄を出すとページは静止画に差し替わるので、その前に撮る（選択の枠と札は
		// ページ側で消してある。awaitNextPaint で消えた後の描画を待つ）
		let image: Uint8Array | undefined;
		const clip = paradisClipRectToViewport(element.rectViewport, element.viewportWidth, element.viewportHeight);
		if (clip) {
			try {
				image = (await model.captureScreenshot({ format: 'png', pageRect: clip, awaitNextPaint: true })).buffer;
			} catch (error) {
				// 画像が無くても注釈としては成り立つ
				this.logService.warn('[ParadisDesignMode] element screenshot failed', error);
			}
		}
		const comment = await this.quickInputService.input({
			title: localize('paradis.designMode.commentTitle', "要素にコメント: {0}", describeElement(element)),
			placeHolder: localize('paradis.designMode.commentPlaceholder', "どう直してほしいかを書いて Enter（空のままでも追加できます）"),
			prompt: localize('paradis.designMode.commentPrompt', "Esc でこの要素を飛ばします。選択をやめるときはページ上で Esc を押します。"),
			validateInput: validateComment,
		});
		if (comment === undefined) {
			void this.syncPins(model);
			return;
		}
		const annotation: IParadisDesignAnnotation = {
			id: generateUuid(),
			kind: 'element',
			comment: comment.trim(),
			pageUrl: element.url || paradisDesignSanitizeUrl(model.url),
			pageTitle: element.title || model.title,
			element,
			image,
		};
		if (!this.designModeService.addAnnotation(model, annotation)) {
			this.notificationService.info(fullMessage());
		}
	}

	async openMarkup(): Promise<void> {
		const model = this.editor.model;
		const container = this.editor.browserContainer;
		const parent = container?.parentElement;
		if (!model || !parent || this.markup.value) {
			return;
		}
		this.stopDesignMode();
		let screenshot: Uint8Array;
		try {
			screenshot = (await model.captureScreenshot({ format: 'png' })).buffer;
		} catch (error) {
			this.notificationService.error(localize('paradis.markup.captureFailed', "スクリーンショットを撮れませんでした: {0}", toErrorMessage(error)));
			return;
		}
		if (this.editor.model !== model || this.markup.value) {
			return;
		}
		this.markupActive.set(true);
		this.markup.value = this.instantiationService.createInstance(ParadisMarkupOverlay, parent, paradisMarkupAreaOf(container), screenshot, (png: Uint8Array | undefined) => {
			this.markupActive.set(false);
			// 閉じる処理の途中で重ね板を捨てないよう、呼び出し元へ戻ってから片付ける
			queueMicrotask(() => this.markup.clear());
			if (png && this.editor.model === model) {
				void this.addMarkupAnnotation(model, png);
			}
			this.editor.focus();
		});
	}

	closeMarkup(): void {
		this.markup.value?.cancel();
	}

	private async addMarkupAnnotation(model: IBrowserViewModel, png: Uint8Array): Promise<void> {
		const comment = await this.quickInputService.input({
			title: localize('paradis.markup.commentTitle', "書き込んだ画像にコメント"),
			placeHolder: localize('paradis.markup.commentPlaceholder', "補足があれば書いて Enter（空のままでも追加できます）"),
			validateInput: validateComment,
		});
		// Esc でもコメント無しで入れる（描いた絵を捨てるのはやめる操作のときだけ）
		const annotation: IParadisDesignAnnotation = {
			id: generateUuid(),
			kind: 'markup',
			comment: (comment ?? '').trim(),
			pageUrl: paradisDesignSanitizeUrl(model.url),
			pageTitle: model.title,
			image: png,
		};
		if (!this.designModeService.addAnnotation(model, annotation)) {
			this.notificationService.info(fullMessage());
		}
	}

	async sendAnnotations(): Promise<void> {
		const model = this.editor.model;
		if (!model || this.sending) {
			return;
		}
		const annotations = this.designModeService.getAnnotations(model.id);
		if (annotations.length === 0) {
			this.notificationService.info(localize('paradis.designMode.empty', "送る注釈がありません。Design Mode でページの要素にコメントを付けてください。"));
			return;
		}
		this.stopDesignMode();
		this.sending = true;
		this.renderTray();
		try {
			if (await this.sender.send(model, annotations)) {
				// 入れた分だけ消す（送っている間に足された注釈は残す）
				for (const annotation of annotations) {
					this.designModeService.removeAnnotation(model.id, annotation.id);
				}
			}
		} finally {
			this.sending = false;
			this.renderTray();
		}
	}

	private clearAnnotations(): void {
		const model = this.editor.model;
		if (model) {
			this.designModeService.clearAnnotations(model.id);
		}
	}

	/** 注釈の一覧から、消すものを選ばせる。 */
	private async manageAnnotations(): Promise<void> {
		const model = this.editor.model;
		if (!model) {
			return;
		}
		const annotations = this.designModeService.getAnnotations(model.id);
		const items: (IQuickPickItem & { readonly annotationId: string })[] = annotations.map((annotation, index) => ({
			label: `${index + 1}. ${annotation.kind === 'markup' ? localize('paradis.designMode.markupItem', "スクリーンショットへの書き込み") : annotation.element ? describeElement(annotation.element) : ''}`,
			description: annotation.comment ? paradisDesignInlineText(annotation.comment, 80) : localize('paradis.designMode.noComment', "（コメントなし）"),
			annotationId: annotation.id,
		}));
		const picked = await this.quickInputService.pick(items, {
			canPickMany: true,
			title: localize('paradis.designMode.manageTitle', "注釈 {0} 件", annotations.length),
			placeHolder: localize('paradis.designMode.managePlaceholder', "消す注釈を選んで Enter"),
		});
		for (const item of picked ?? []) {
			this.designModeService.removeAnnotation(model.id, item.annotationId);
		}
	}

	private trayButton(label: string, primary: boolean, run: () => void): HTMLButtonElement {
		const button = append(this.tray, $<HTMLButtonElement>('button.paradis-design-tray-button'));
		button.type = 'button';
		button.classList.toggle('primary', primary);
		button.textContent = label;
		this._register(addDisposableListener(button, EventType.CLICK, () => run()));
		return button;
	}

	private renderTray(): void {
		const model = this.editor.model;
		const annotations = model ? this.designModeService.getAnnotations(model.id) : [];
		const picking = !!model && this.designPage === model;
		const visible = annotations.length > 0 || picking;

		this.countButton.textContent = localize('paradis.designMode.count', "注釈 {0} 件", annotations.length);
		this.countButton.disabled = annotations.length === 0;
		this.hint.textContent = picking
			? localize('paradis.designMode.hint', "ページの要素をクリックしてコメントを付けます（Esc で終了）")
			: '';
		const imageCount = annotations.filter(annotation => annotation.image).length;
		this.attachLabel.style.display = imageCount > 0 ? '' : 'none';
		this.attachText.textContent = localize('paradis.designMode.attachImages', "画像 {0} 枚を添える", imageCount);
		this.attachCheckbox.checked = this.designModeService.attachImages;
		this.stopButton.style.display = picking ? '' : 'none';
		this.clearButton.disabled = annotations.length === 0 || this.sending;
		this.sendButton.disabled = annotations.length === 0 || this.sending;

		if (visible !== this.trayVisible) {
			this.trayVisible = visible;
			this.tray.style.display = visible ? '' : 'none';
			// 帯の高さの分だけページの領域が変わるので、ネイティブのビューの位置を合わせ直す
			this.editor.layoutBrowserContainer();
		}
	}

	/** ページ上の番号札を、今の注釈に合わせて置き直す。 */
	private async syncPins(model: IBrowserViewModel): Promise<void> {
		const pageUrl = paradisDesignSanitizeUrl(model.url);
		const pins: IParadisDesignPin[] = [];
		this.designModeService.getAnnotations(model.id).forEach((annotation, index) => {
			if (annotation.element && annotation.pageUrl === pageUrl) {
				pins.push({ label: String(index + 1), selector: annotation.element.selector, rectPage: annotation.element.rectPage });
			}
		});
		try {
			await this.designModeService.setPins(model.id, pins);
		} catch (error) {
			this.logService.trace('[ParadisDesignMode] pins could not be placed', error);
		}
	}
}
