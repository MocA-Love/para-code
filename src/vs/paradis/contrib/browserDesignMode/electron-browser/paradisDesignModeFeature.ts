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
//  - 注釈トレイ: ナビバーとページの間の帯。右端のボタンに既定の送り先の名前を出して 1 回で送り、
//    ▾ で一覧を開く（Q663-7〜10）。相手が質問・許可の確認を出している間は「空いたら入れる」予約になる
//
// upstream のファイルには触らず、BrowserEditor.registerContribution() と
// BrowserWidgetLocation.Toolbar（ナビバーとページの間）だけを使う。
//
// 結果やエラーは通知のトーストではなくトレイの中に出す。fork ではトーストが内蔵ブラウザの
// ページ（ネイティブのビュー）を止めない設定なので、トーストはページの裏に隠れて見えない。
// エラーはトレイに出したうえで、後から見返せるようベル（通知センター）にも残す。

import { $, addDisposableListener, append, clearNode, EventType, isActiveElement } from '../../../../base/browser/dom.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
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
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisAgentBrowserBindingModel } from '../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisAgentStatusStore } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisDesignPin, IParadisPickedElement, PARADIS_DESIGN_BUDGET, paradisClipRectToViewport, paradisDesignSanitizeUrl } from '../common/paradisDesignMode.js';
import { IParadisDesignAnnotation, paradisDesignInlineText } from '../common/paradisDesignModeFormat.js';
import { IParadisDesignModeService } from './paradisDesignModeService.js';
import { IParadisDesignSendResult, IParadisDesignTargetEntry, ParadisDesignModeSender, ParadisDesignTargetPick, paradisDesignStatusWord, paradisDesignSubmitKeyLabel } from './paradisDesignModeSender.js';
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

/** 「空いたら入れる」予約（ページごと）。相手が質問・許可の確認を閉じたら、その時点のトレイの中身を入れる。 */
interface IParadisDesignReservation {
	readonly model: IBrowserViewModel;
	readonly instanceId: number;
	readonly title: string;
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
	private readonly stopButton: HTMLButtonElement;
	/** 送り先の札（相手の状態。回答待ち・予約中のときだけ出す）。 */
	private readonly targetState: HTMLElement;
	private readonly targetStateDot: HTMLElement;
	private readonly targetStateWho: HTMLElement;
	private readonly targetStateText: HTMLElement;
	/** 送るキーの案内（Enter で入れる・⌘Enter で送信まで）。 */
	private readonly keysHint: HTMLElement;
	/** 送るボタン（送り先の名前）と ▾ の組。予約中は「取り消す」に替える。 */
	private readonly target: HTMLElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly sendIcon: HTMLElement;
	private readonly sendLabel: HTMLElement;
	private readonly moreButton: HTMLButtonElement;
	private readonly sendHover: IManagedHover;
	private readonly cancelReservationButton: HTMLButtonElement;
	private readonly reservations = new Map<string, IParadisDesignReservation>();
	private readonly reservationListeners = this._register(new DisposableMap<string>());

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
		@IParadisAgentStatusStore private readonly agentStatusStore: IParadisAgentStatusStore,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IParadisAgentBrowserBindingModel bindingModel: IParadisAgentBrowserBindingModel,
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

		this.keysHint = append(this.tray, $('span.paradis-design-tray-keys'));
		const enterKey = append(this.keysHint, $('kbd'));
		enterKey.textContent = 'Enter';
		append(this.keysHint, $('span')).textContent = localize('paradis.designMode.keys.insert', "入力欄へ入れる");
		const submitKey = append(this.keysHint, $('kbd'));
		submitKey.textContent = paradisDesignSubmitKeyLabel();
		append(this.keysHint, $('span')).textContent = localize('paradis.designMode.keys.submit', "送信まで");

		this.targetState = append(this.tray, $('span.paradis-design-tray-state'));
		this.targetStateDot = append(this.targetState, $('span.paradis-design-tray-state-dot'));
		this.targetStateWho = append(this.targetState, $('span.paradis-design-tray-state-who'));
		this.targetStateText = append(this.targetState, $('span.paradis-design-tray-state-text'));

		this.target = append(this.tray, $('span.paradis-design-tray-target'));
		this.target.setAttribute('role', 'group');
		this.sendButton = append(this.target, $<HTMLButtonElement>('button.paradis-design-tray-target-send'));
		this.sendButton.type = 'button';
		this.sendIcon = append(this.sendButton, $('span'));
		this.sendLabel = append(this.sendButton, $('span.paradis-design-tray-target-label'));
		this.sendHover = this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.sendButton, ''));
		// クリックは入れるだけ、⌘（Ctrl）を押しながらのクリックと ⌘Enter（Ctrl+Enter）は送信まで（Q663-10）
		this._register(addDisposableListener(this.sendButton, EventType.CLICK, (event: MouseEvent) => {
			void this.sendAnnotations({ submit: isMacintosh ? event.metaKey : event.ctrlKey });
		}));
		this._register(addDisposableListener(this.sendButton, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (new StandardKeyboardEvent(event).equals(KeyMod.CtrlCmd | KeyCode.Enter)) {
				event.preventDefault();
				event.stopPropagation();
				void this.sendAnnotations({ submit: true });
			}
		}));
		this.moreButton = append(this.target, $<HTMLButtonElement>('button.paradis-design-tray-target-more'));
		this.moreButton.type = 'button';
		// アイコンは子に付ける（ボタンの font: inherit が codicon のフォントを打ち消すため）
		append(this.moreButton, $(ThemeIcon.asCSSSelector(Codicon.chevronDown)));
		const moreLabel = localize('paradis.designMode.pickTarget', "別の送り先を選ぶ");
		this.moreButton.setAttribute('aria-label', moreLabel);
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.moreButton, moreLabel));
		this._register(addDisposableListener(this.moreButton, EventType.CLICK, () => void this.sendAnnotations({ pick: true })));
		this.cancelReservationButton = this.trayButton(localize('paradis.designMode.cancelReservation', "取り消す"), false, () => this.cancelReservation(this.editor.model?.id));

		// 送り先の名前と状態は、相手の状態・共有・ターミナルの名前が変わったら描き直す
		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => this.renderTray()));
		this._register(bindingModel.onDidChange(() => this.renderTray()));
		this._register(this.terminalService.onDidChangeInstances(() => this.renderTray()));
		this._register(this.terminalService.onAnyInstanceTitleChange(() => this.renderTray()));
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
				// トレイが空になったら、入れるものが無いので予約も取り消す
				if (this.designModeService.getAnnotations(model.id).length === 0) {
					this.cancelReservation(model.id);
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
				if (result.kind === 'blocked') {
					this.showMessage(localize('paradis.designMode.blockedByDialog', "ページのダイアログが開いている間は要素を選べないため、選択をやめました。ダイアログを閉じてからもう一度始めてください。"), Severity.Info);
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

	/**
	 * トレイの注釈を送る。既定の送り先があればそこへ、無いか `pick` のときは一覧から選ぶ。
	 * `submit` は Enter まで送るか（⌘Enter・Ctrl+Enter）。相手が質問・許可の確認を出していれば
	 * 「空いたら入れる」予約にする。
	 */
	async sendAnnotations(options: { readonly pick?: boolean; readonly submit?: boolean } = {}): Promise<void> {
		const model = this.editor.model;
		if (!model || this.sending || this.reservations.has(model.id)) {
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
			let target: ParadisDesignTargetPick | undefined;
			let submit = !!options.submit;
			const defaultTarget = options.pick ? undefined : this.sender.defaultTarget(model);
			if (defaultTarget) {
				target = { kind: 'pane', instanceId: defaultTarget.instanceId };
			} else {
				const picked = await this.sender.pickTarget(model, annotations);
				if (!picked || cancellation.token.isCancellationRequested) {
					return;
				}
				target = picked.target;
				submit ||= picked.submit;
				if (target.kind === 'pane') {
					// 一覧から選んだペインを、このタブの次からの送り先にする（Q663-9。共有はしない）
					this.designModeService.setLastTarget(model, target.instanceId);
				}
			}
			if (target.kind === 'pane' && !this.sender.isReady(target.instanceId)) {
				this.reserve(model, target.instanceId);
				return;
			}
			const result = await this.sender.deliver(model, annotations, target, { submit, focus: true }, cancellation.token);
			if (target.kind === 'launch' && result.inserted && result.instanceId !== undefined && this.editor.model === model) {
				// 新しく起動して入れたペインも、このタブの次からの送り先にする
				this.designModeService.setLastTarget(model, result.instanceId);
			}
			this.applyResult(model, annotations, result);
		} finally {
			if (this.sendCancellation.value === cancellation) {
				this.sendCancellation.clear();
			}
			this.sending = false;
			this.renderTray();
			this.retryReservations();
		}
	}

	/** 送っている間に予約の相手が空いていたら、その分を入れる（空いた知らせは送っている間は見送るため）。 */
	private retryReservations(): void {
		for (const reservation of [...this.reservations.values()]) {
			void this.fireReservation(reservation.model);
		}
	}

	private applyResult(model: IBrowserViewModel, annotations: readonly IParadisDesignAnnotation[], result: IParadisDesignSendResult): void {
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
	}

	/** 「空いたら入れる」予約を始める（Q663-8）。 */
	private reserve(model: IBrowserViewModel, instanceId: number): void {
		const instance = this.terminalService.getInstanceFromId(instanceId);
		if (!instance || instance.isDisposed) {
			return;
		}
		const pageId = model.id;
		const store = new DisposableStore();
		store.add(this.agentStatusStore.onDidChangeAgentStatuses(() => void this.fireReservation(model)));
		store.add(this.terminalService.onDidDisposeInstance(disposed => {
			if (disposed.instanceId === instanceId) {
				this.cancelReservation(pageId, localize('paradis.designMode.reservationGone', "「{0}」が閉じられたため、予約を取り消しました。", instance.title));
			}
		}));
		store.add(model.onWillDispose(() => this.cancelReservation(pageId)));
		this.reservations.set(pageId, { model, instanceId, title: instance.title });
		this.reservationListeners.set(pageId, store);
		this.showMessage(localize('paradis.designMode.reserved', "「{0}」が空いたら入れます。", instance.title), Severity.Info);
	}

	private cancelReservation(pageId: string | undefined, message?: string): void {
		if (pageId === undefined || !this.reservations.delete(pageId)) {
			return;
		}
		this.reservationListeners.deleteAndDispose(pageId);
		if (this.editor.model?.id === pageId) {
			if (isActiveElement(this.cancelReservationButton)) {
				this.editor.focus();
			}
			if (message) {
				this.showMessage(message, Severity.Info);
			} else {
				this.renderTray();
			}
		}
	}

	/**
	 * 予約の相手が空いたら、その時点のトレイの中身を入れる。Enter は送らず、フォーカスも移さない
	 * （利用者が別の操作をしている時刻に起きるため）。結果はトレイの文で知らせる。
	 */
	private async fireReservation(model: IBrowserViewModel): Promise<void> {
		const reservation = this.reservations.get(model.id);
		if (!reservation || this.sending || !this.sender.isReady(reservation.instanceId)) {
			return;
		}
		this.reservations.delete(model.id);
		this.reservationListeners.deleteAndDispose(model.id);
		const annotations = this.designModeService.getAnnotations(model.id);
		if (annotations.length === 0) {
			this.renderTray();
			return;
		}
		this.sending = true;
		this.renderTray();
		try {
			const result = await this.sender.deliver(model, annotations, { kind: 'pane', instanceId: reservation.instanceId }, { submit: false, focus: false }, CancellationToken.None);
			this.applyResult(model, annotations, result);
		} finally {
			this.sending = false;
			this.renderTray();
			this.retryReservations();
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
		if (!this.clearedAnnotations && isActiveElement(this.undoButton)) {
			// 隠す「元に戻す」にフォーカスがあったら、隠す前にエディタへ戻す（body へ落とさない）
			this.editor.focus();
		}
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
		this.renderTarget(visible ? model : undefined, annotations.length > 0);

		if (visible !== this.trayVisible) {
			this.trayVisible = visible;
			this.tray.style.display = visible ? '' : 'none';
			// 帯の高さの分だけページの領域が変わるので、ネイティブのビューの位置を合わせ直す
			this.editor.layoutBrowserContainer();
		}
	}

	/** 送り先のボタン・状態の札・キーの案内を描く。 */
	private renderTarget(model: IBrowserViewModel | undefined, hasAnnotations: boolean): void {
		const reservation = model ? this.reservations.get(model.id) : undefined;
		// 送った直後（0 件）も、次の送り先の名前は出したままにする（押せないだけ）
		const entry: IParadisDesignTargetEntry | undefined = model && !reservation ? this.sender.defaultTarget(model) : undefined;
		const queue = !!entry && !entry.available;

		this.cancelReservationButton.style.display = reservation ? '' : 'none';
		this.target.style.display = reservation ? 'none' : '';
		this.target.classList.toggle('queue', queue);
		this.sendButton.disabled = !hasAnnotations || this.sending;
		this.moreButton.disabled = !hasAnnotations || this.sending;
		this.moreButton.style.display = entry ? '' : 'none';
		this.sendIcon.className = ThemeIcon.asClassName(queue ? Codicon.clock : Codicon.send);
		let label: string;
		let hover: string;
		if (!entry) {
			label = localize('paradis.designMode.chooseTarget', "送り先を選ぶ…");
			hover = label;
		} else if (queue) {
			label = localize('paradis.designMode.sendWhenFree', "空いたら入れる");
			hover = localize('paradis.designMode.sendWhenFreeHover', "「{0}」が確認を閉じたら、入力欄へ入れます", entry.title);
		} else {
			label = localize('paradis.designMode.sendTo', "{0}へ送る", entry.title);
			hover = localize('paradis.designMode.sendToHover', "「{0}」の入力欄へ入れる（{1} で送信まで）", entry.title, paradisDesignSubmitKeyLabel());
		}
		this.sendLabel.textContent = label;
		this.sendButton.setAttribute('aria-label', hover);
		this.sendHover.update(hover);

		// キーの案内は、すぐ入れられる送り先が決まっていて、お知らせが出ていないときだけ
		this.keysHint.style.display = entry && !queue && hasAnnotations && !this.messageText && !this.sending ? '' : 'none';

		const state = reservation
			? { kind: 'queued', who: reservation.title, text: localize('paradis.designMode.reservedState', "空いたら入れる（予約中）") }
			: queue && entry && hasAnnotations ? { kind: entry.status ?? 'idle', who: entry.title, text: paradisDesignStatusWord(entry.status) } : undefined;
		this.targetState.style.display = state ? '' : 'none';
		if (state) {
			this.targetStateDot.className = `paradis-design-tray-state-dot ${state.kind}`;
			this.targetStateWho.textContent = state.who;
			this.targetStateText.textContent = state.text;
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
