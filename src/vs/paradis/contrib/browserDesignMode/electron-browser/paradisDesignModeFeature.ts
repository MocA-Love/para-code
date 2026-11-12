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
//  - 注釈トレイ: ナビバーとページの間の帯。[送る] で送り先を一覧から選ぶ
//
// upstream のファイルには触らず、BrowserEditor.registerContribution() と
// BrowserWidgetLocation.Toolbar（ナビバーとページの間）だけを使う。
//
// 結果やエラーは通知のトーストではなくトレイの中に出す。fork ではトーストが内蔵ブラウザの
// ページ（ネイティブのビュー）を止めない設定なので、トーストはページの裏に隠れて見えない。
// エラーはトレイに出したうえで、後から見返せるようベル（通知センター）にも残す。

import { $, addDisposableListener, append, clearNode, EventType, isActiveElement } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultCheckboxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, IBrowserEditorWidget } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IParadisDesignPin, IParadisPickedElement, PARADIS_DESIGN_BUDGET, paradisClipRectToViewport, paradisDesignSanitizeUrl } from '../common/paradisDesignMode.js';
import { IParadisDesignAnnotation, paradisDesignInlineText } from '../common/paradisDesignModeFormat.js';
import { IParadisDesignModeService } from './paradisDesignModeService.js';
import { ParadisDesignModeSender } from './paradisDesignModeSender.js';
import { ParadisMarkupOverlay, paradisMarkupAreaOf } from './paradisMarkupOverlay.js';

export const CONTEXT_PARADIS_DESIGN_MODE_ACTIVE = new RawContextKey<boolean>('paradisBrowserDesignModeActive', false, localize('paradis.designMode.contextActive', "内蔵ブラウザで Design Mode（要素にコメント）が有効か"));
export const CONTEXT_PARADIS_MARKUP_ACTIVE = new RawContextKey<boolean>('paradisBrowserMarkupActive', false, localize('paradis.designMode.contextMarkup', "内蔵ブラウザでスクリーンショットへ書き込み中か"));

/** トレイに出したお知らせを消すまでの時間。 */
const MESSAGE_DURATION_MS = 12_000;

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
	private readonly message: HTMLElement;
	private readonly htmlLabel: HTMLLabelElement;
	private readonly htmlCheckbox: Checkbox;
	private readonly messageClear = this._register(new RunOnceScheduler(() => this.expireMessage(), MESSAGE_DURATION_MS));
	private messageText: string | undefined;
	/** 送信中の取り消し（エディタのページが替わる・閉じるとき）。 */
	private readonly sendCancellation = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly countButton: HTMLButtonElement;
	private readonly attachLabel: HTMLLabelElement;
	private readonly attachCheckbox: Checkbox;
	private readonly attachText: HTMLElement;
	private readonly clearButton: HTMLButtonElement;
	private readonly undoButton: HTMLButtonElement;
	/** 「すべて消す」で消した注釈。お知らせが消えるまで「元に戻す」で戻せる。 */
	private clearedAnnotations: { readonly pageId: string; readonly annotations: readonly IParadisDesignAnnotation[] } | undefined;
	/** 「元に戻す」で注釈を戻している間（その追加では戻せる状態を捨てない）。 */
	private restoringCleared = false;
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
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super(editor);
		this.designModeActive = CONTEXT_PARADIS_DESIGN_MODE_ACTIVE.bindTo(contextKeyService);
		this.markupActive = CONTEXT_PARADIS_MARKUP_ACTIVE.bindTo(contextKeyService);
		this.sender = instantiationService.createInstance(ParadisDesignModeSender);

		this.tray = $('.paradis-design-tray');
		// 矢印キーでは動かさない（ボタンが少なくチェックも混ざる）ので、toolbar ではなく group にする（paradis-16-24）
		this.tray.setAttribute('role', 'group');
		this.tray.setAttribute('aria-label', localize('paradis.designMode.tray', "注釈トレイ"));
		this.tray.style.display = 'none';

		this.countButton = append(this.tray, $<HTMLButtonElement>('button.paradis-design-tray-count'));
		this.countButton.type = 'button';
		this._register(addDisposableListener(this.countButton, EventType.CLICK, () => void this.manageAnnotations()));

		this.hint = append(this.tray, $('span.paradis-design-tray-hint'));
		this.message = append(this.tray, $('span.paradis-design-tray-message'));
		this.message.setAttribute('role', 'status');
		this.message.setAttribute('aria-live', 'polite');
		// 「すべて消す」の直後だけ出す（paradis-16-12 案 B）。お知らせと一緒に 12 秒で消える
		this.undoButton = this.trayButton(localize('paradis.designMode.undoClear', "元に戻す"), false, () => this.undoClear());
		this.undoButton.style.display = 'none';

		// チェックは本家の Checkbox（Q537 の 7 章「Design Mode」、案 A）。文字を押しても切り替わる
		this.attachLabel = append(this.tray, $<HTMLLabelElement>('label.paradis-design-tray-attach'));
		this.attachText = $('span');
		this.attachCheckbox = this._register(new Checkbox(localize('paradis.designMode.attachImagesTitle', "書き込んだ画像を添える"), false, defaultCheckboxStyles));
		append(this.attachLabel, this.attachCheckbox.domNode, this.attachText);
		this._register(this.attachCheckbox.onChange(() => {
			this.designModeService.attachImages = this.attachCheckbox.checked;
		}));
		this._register(addDisposableListener(this.attachText, EventType.CLICK, () => {
			this.attachCheckbox.checked = !this.attachCheckbox.checked;
			this.designModeService.attachImages = this.attachCheckbox.checked;
		}));

		this.htmlLabel = append(this.tray, $<HTMLLabelElement>('label.paradis-design-tray-attach'));
		const htmlText = $('span');
		htmlText.textContent = localize('paradis.designMode.includeHtml', "HTML も送る");
		this.htmlCheckbox = this._register(new Checkbox(htmlText.textContent, false, defaultCheckboxStyles));
		append(this.htmlLabel, this.htmlCheckbox.domNode, htmlText);
		this._register(this.htmlCheckbox.onChange(() => {
			this.designModeService.includeHtml = this.htmlCheckbox.checked;
		}));
		this._register(addDisposableListener(htmlText, EventType.CLICK, () => {
			this.htmlCheckbox.checked = !this.htmlCheckbox.checked;
			this.designModeService.includeHtml = this.htmlCheckbox.checked;
		}));

		append(this.tray, $('span.paradis-design-tray-spacer'));

		this.stopButton = this.trayButton(localize('paradis.designMode.stop', "選択をやめる"), false, () => this.stopDesignMode());
		this.clearButton = append(this.tray, $<HTMLButtonElement>(`button.paradis-design-tray-icon${ThemeIcon.asCSSSelector(Codicon.clearAll)}`));
		this.clearButton.type = 'button';
		const clearLabel = localize('paradis.designMode.clearAll', "すべて消す");
		this.clearButton.setAttribute('aria-label', clearLabel);
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.clearButton, clearLabel));
		this._register(addDisposableListener(this.clearButton, EventType.CLICK, () => this.clearAnnotations()));
		this.sendButton = this.trayButton(localize('paradis.designMode.send', "送る"), true, () => void this.sendAnnotations());
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [{ location: BrowserWidgetLocation.Toolbar, element: this.tray, order: TRAY_ORDER }];
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		store.add(this.designModeService.onDidChangeAnnotations(pageId => {
			if (pageId === model.id) {
				// 消した後に新しい注釈が付いたら、戻すと番号が元の順とずれるので、もう戻せなくする
				if (this.clearedAnnotations && !this.restoringCleared && this.designModeService.getAnnotations(model.id).length > 0) {
					this.dropUndo();
				}
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
			this.sendCancellation.value?.cancel();
			this.showMessage(undefined);
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
					this.showMessage(fullMessage(), Severity.Info);
					break;
				}
				const result = await this.designModeService.pickElement(model.id, this.pinsFor(model));
				if (this.designGeneration !== generation || result.kind === 'cancelled') {
					break;
				}
				await this.addElementAnnotation(model, result.element);
			}
		} catch (error) {
			this.logService.warn('[ParadisDesignMode] element picking failed', error);
			this.showMessage(localize('paradis.designMode.pickFailed', "要素を選べませんでした: {0}", toErrorMessage(error)), Severity.Error);
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
			this.showMessage(fullMessage(), Severity.Info);
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
			this.showMessage(localize('paradis.markup.captureFailed', "スクリーンショットを撮れませんでした: {0}", toErrorMessage(error)), Severity.Error);
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
			this.showMessage(fullMessage(), Severity.Info);
		}
	}

	async sendAnnotations(): Promise<void> {
		const model = this.editor.model;
		if (!model || this.sending) {
			return;
		}
		const annotations = this.designModeService.getAnnotations(model.id);
		if (annotations.length === 0) {
			this.showMessage(localize('paradis.designMode.empty', "送る注釈がありません。Design Mode でページの要素にコメントを付けてください。"), Severity.Info);
			return;
		}
		this.stopDesignMode();
		this.showMessage(undefined);
		this.sending = true;
		this.renderTray();
		const cancellation = new CancellationTokenSource();
		this.sendCancellation.value = cancellation;
		try {
			const result = await this.sender.send(model, annotations, cancellation.token);
			if (result.inserted) {
				// 入れた分だけ消す（送っている間に足された注釈は残す）
				for (const annotation of annotations) {
					this.designModeService.removeAnnotation(model.id, annotation.id);
				}
			}
			if (result.message && this.editor.model === model) {
				// エラーはベルへの記録を送る側で済ませてあるので、ここではトレイに出すだけ
				this.showMessage(result.message, result.severity ?? Severity.Info, false);
			}
		} finally {
			if (this.sendCancellation.value === cancellation) {
				this.sendCancellation.clear();
			}
			this.sending = false;
			this.renderTray();
		}
	}

	/** すぐ消して、お知らせの間だけ「元に戻す」を出す（paradis-16-12 案 B）。 */
	private clearAnnotations(): void {
		const model = this.editor.model;
		if (!model) {
			return;
		}
		const annotations = [...this.designModeService.getAnnotations(model.id)];
		if (annotations.length === 0) {
			return;
		}
		// 先にお知らせを出してから消す（逆だと 0 件・お知らせ無しの間にトレイが一度閉じ、ページの位置が 2 回動く）
		this.showMessage(localize('paradis.designMode.cleared', "注釈 {0} 件を消しました。", annotations.length), Severity.Info, false, { pageId: model.id, annotations });
		this.designModeService.clearAnnotations(model.id);
		if (this.undoButton.isConnected) {
			this.undoButton.focus();
		}
	}

	private undoClear(): void {
		const cleared = this.clearedAnnotations;
		const model = this.editor.model;
		if (!cleared || !model || model.id !== cleared.pageId) {
			this.showMessage(undefined);
			return;
		}
		// 先に戻してからお知らせを消す（逆だと 0 件の間にトレイが一度閉じ、ページの位置が 2 回動く）
		let full = false;
		this.restoringCleared = true;
		try {
			for (const annotation of cleared.annotations) {
				if (!this.designModeService.addAnnotation(model, annotation)) {
					full = true;
					break;
				}
			}
		} finally {
			this.restoringCleared = false;
		}
		this.showMessage(full ? fullMessage() : undefined);
		if (!this.clearButton.disabled) {
			this.clearButton.focus();
		}
	}

	/** 「元に戻す」を引っ込める。お知らせの文は残す。 */
	private dropUndo(): void {
		if (isActiveElement(this.undoButton)) {
			this.editor.focus();
		}
		this.clearedAnnotations = undefined;
		this.undoButton.style.display = 'none';
	}

	/** お知らせの時間切れ。「元に戻す」にフォーカスがあったら、消える前にエディタへ戻す（body へ落とさない）。 */
	private expireMessage(): void {
		if (isActiveElement(this.undoButton)) {
			this.editor.focus();
		}
		this.showMessage(undefined);
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

	/**
	 * トレイにお知らせを出す（undefined で消す）。しばらくすると消える。エラーは既定でベルにも残す。
	 */
	private showMessage(text: string | undefined, severity: Severity = Severity.Info, recordErrors = true, cleared?: { readonly pageId: string; readonly annotations: readonly IParadisDesignAnnotation[] }): void {
		this.messageText = text;
		// 別のお知らせに替わった・消えたら、もう戻せない
		this.clearedAnnotations = text ? cleared : undefined;
		this.undoButton.style.display = this.clearedAnnotations ? '' : 'none';
		this.message.textContent = text ?? '';
		this.message.classList.toggle('error', severity === Severity.Error);
		this.message.classList.toggle('warning', severity === Severity.Warning);
		if (text) {
			this.messageClear.schedule();
			if (severity === Severity.Error && recordErrors) {
				this.notificationService.notify({ severity, message: text, sticky: true });
			}
		} else {
			this.messageClear.cancel();
		}
		this.renderTray();
	}

	private renderTray(): void {
		const model = this.editor.model;
		const annotations = model ? this.designModeService.getAnnotations(model.id) : [];
		const picking = !!model && this.designPage === model;
		const visible = !!model && (annotations.length > 0 || picking || !!this.messageText);

		// 印と数（本家のバッジ）。読み上げは「注釈 N 件」
		clearNode(this.countButton);
		append(this.countButton, $(`span${ThemeIcon.asCSSSelector(Codicon.commentDiscussion)}`));
		append(this.countButton, $('span.paradis-design-tray-badge')).textContent = String(annotations.length);
		this.countButton.setAttribute('aria-label', localize('paradis.designMode.count', "注釈 {0} 件", annotations.length));
		this.countButton.disabled = annotations.length === 0;
		this.hint.textContent = picking
			? localize('paradis.designMode.hint', "ページの要素をクリックしてコメントを付けます（Esc で終了）")
			: '';
		const imageCount = annotations.filter(annotation => annotation.image).length;
		this.attachLabel.style.display = imageCount > 0 ? '' : 'none';
		this.attachText.textContent = localize('paradis.designMode.attachImages', "画像 {0} 枚を添える", imageCount);
		this.attachCheckbox.checked = this.designModeService.attachImages;
		this.htmlCheckbox.checked = this.designModeService.includeHtml;
		this.htmlLabel.style.display = annotations.some(annotation => annotation.element?.htmlSnippet) ? '' : 'none';
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

	/** このページに出す番号札（番号は送る文章の項目番号と同じ）。 */
	private pinsFor(model: IBrowserViewModel): IParadisDesignPin[] {
		const pageUrl = paradisDesignSanitizeUrl(model.url);
		const pins: IParadisDesignPin[] = [];
		this.designModeService.getAnnotations(model.id).forEach((annotation, index) => {
			if (annotation.element && annotation.pageUrl === pageUrl) {
				pins.push({ label: String(index + 1), selector: annotation.element.selector, rectPage: annotation.element.rectPage });
			}
		});
		return pins;
	}

	/** ページ上の番号札を、今の注釈に合わせて置き直す。 */
	private async syncPins(model: IBrowserViewModel): Promise<void> {
		try {
			await this.designModeService.setPins(model.id, this.pinsFor(model));
		} catch (error) {
			this.logService.trace('[ParadisDesignMode] pins could not be placed', error);
		}
	}
}
