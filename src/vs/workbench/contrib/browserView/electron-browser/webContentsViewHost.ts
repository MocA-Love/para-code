/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/browser.css';
import { $, addDisposableListener, EventType, registerExternalFocusChecker } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import type { CodeWindow } from '../../../../base/browser/window.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IBrowserViewKeyDownEvent } from '../../../../platform/browserView/common/browserView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IBrowserViewModel } from '../common/browserView.js';
import { BrowserOverlayManager, BrowserOverlayType } from './overlayManager.js';
import { ParadisBrowserContainerFocusGuard, paradisWatchBrowserContainerFocus } from '../../../../paradis/contrib/agentBrowser/browser/paradisBrowserContainerFocusGuard.js'; // PARA-PATCH: keep a click elsewhere in the workbench from sending focus back into the page (Para Code)

const originalHtmlElementFocus = HTMLElement.prototype.focus;

export function focusWebContentsViewContainer(container: HTMLElement): void {
	originalHtmlElementFocus.call(container);
	container.ownerDocument.getSelection()?.removeAllRanges();
}

/** Native browser content presentation without browser chrome or editor ownership. */
export class WebContentsViewHost extends Disposable {

	private _container: HTMLElement | undefined;
	private _model: IBrowserViewModel | undefined;
	private _editorVisible = false;
	private _overlayObscured = false;

	private readonly _placeholderScreenshot = $('.browser-placeholder-screenshot');
	private readonly _overlayPauseElement = $('.browser-overlay-paused');
	private readonly _overlayManager: BrowserOverlayManager;
	private readonly _modelStore = this._register(new DisposableStore());
	private readonly _screenshotHandle = this._register(new MutableDisposable());
	private _focusTimeout: ReturnType<typeof setTimeout> | undefined;
	private _screenshotSequence = 0;
	// PARA-PATCH: a show that had to wait for the container to be measured (see _refresh)
	private _showPendingLayout = false;
	private _pushingBounds = false;
	private _paradisBoundsPusher: (() => boolean) | undefined;
	// PARA-PATCH: tells a re-activation focus after a click elsewhere from a deliberate one (Para Code)
	private readonly _paradisFocusGuard = new ParadisBrowserContainerFocusGuard();

	get screenshotElement(): HTMLElement { return this._placeholderScreenshot; }
	get pauseElement(): HTMLElement { return this._overlayPauseElement; }

	constructor(
		private readonly targetWindow: CodeWindow,
		private readonly ensureBrowserFocus: () => void,
		@ILogService private readonly logService: ILogService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super();

		this._overlayManager = this._register(new BrowserOverlayManager(targetWindow));
		const message = $('.browser-overlay-paused-message');
		const heading = $('.browser-overlay-paused-heading');
		const detail = $('.browser-overlay-paused-detail');
		heading.textContent = localize('browser.overlayPauseHeading.notification', "Paused due to Notification");
		detail.textContent = localize('browser.overlayPauseDetail.notification', "Dismiss the notification to continue using the browser.");
		message.appendChild(heading);
		message.appendChild(detail);
		this._overlayPauseElement.appendChild(message);

		this._register(this._overlayManager.onDidChangeOverlayState(() => this._refreshOverlayObscured()));
		this._refresh();
	}

	onContainerCreated(container: HTMLElement): void {
		this._container = container;
		// PARA-PATCH: the document regaining focus re-delivers `focus` to the container; ignore it when the user pressed outside the container (Para Code)
		this._register(addDisposableListener(container, EventType.FOCUS, () => {
			if (this._paradisFocusGuard.noteContainerFocusEvent(this.targetWindow.document.hasFocus())) {
				this.tryFocus(true);
			}
		}));
		this._register(paradisWatchBrowserContainerFocus(this.targetWindow, container, this._paradisFocusGuard, () => this._cancelFocusTimeout()));
		this._register(addDisposableListener(container, EventType.BLUR, () => this._cancelFocusTimeout()));
		this._register(registerExternalFocusChecker(() => ({
			hasFocus: this._model?.focused ?? false,
			window: this._model?.focused ? this.targetWindow : undefined,
		})));
		this._refreshOverlayObscured();
	}

	setVisible(visible: boolean): void {
		if (this._editorVisible !== visible) {
			this._editorVisible = visible;
			this._refresh();
		}
	}

	layout(): void {
		this._refreshOverlayObscured();

		// PARA-PATCH: bounds are now current, so a show we held back can go ahead.
		if (this._showPendingLayout && !this._pushingBounds) {
			this._showPendingLayout = false;
			this._refresh(true);
		}
	}

	/**
	 * PARA-PATCH: let the owner push the container's current bounds to main before the page is shown.
	 * The pusher lays the container out and returns whether bounds reached main. Without one (e.g. the
	 * sessions canvas) the host shows the page right away, as upstream does.
	 */
	paradisSetBoundsPusher(pusher: () => boolean): void {
		this._paradisBoundsPusher = pusher;
	}

	// PARA-PATCH: optional `paradisFromFocusEvent` marks the container's own focus event; any other call is a deliberate focus (Para Code)
	tryFocus(paradisFromFocusEvent?: boolean): boolean {
		if (!this._model?.url) {
			return false;
		}
		if (!paradisFromFocusEvent) {
			this._paradisFocusGuard.noteDeliberateFocus();
		}
		this._container?.focus();
		if (this._focusTimeout || !this._model) {
			return true;
		}
		this._focusTimeout = setTimeout(() => {
			this._focusTimeout = undefined;
			this._paradisFocusGuard.notePendingFocusSettled(); // PARA-PATCH (Para Code)
			const targetDocument = this.targetWindow.document;
			if (!targetDocument.hasFocus() || targetDocument.activeElement !== this._container) {
				return;
			}
			if (this._model?.visible) {
				void this._model.focus(undefined, 'container-focus'); // PARA-PATCH: tell focus diagnostics this came from the container's DOM focus (Para Code browser focus diagnostics)
			} else {
				this.ensureBrowserFocus();
			}
		}, 10);
		return true;
	}

	setModel(model: IBrowserViewModel | undefined): void {
		if (model === this._model) {
			return;
		}
		this._detachModel();
		if (!model) {
			return;
		}
		this._model = model;
		this._setBackgroundImage(model.screenshot);
		this._modelStore.add(model.onDidChangeVisibility(() => void this._captureScreenshot()));
		this._modelStore.add(model.onDidKeyCommand(event => void this._handleKeyEvent(event)));
		// PARA-PATCH: the page taking focus (the user clicked it) is a deliberate focus (Para Code)
		this._modelStore.add(model.onDidChangeFocus(({ focused }) => {
			if (focused) {
				this._paradisFocusGuard.noteDeliberateFocus();
			}
		}));
		// PARA-PATCH: restartScreenshot is the second argument (the first is the fork's boundsArePushed)
		this._modelStore.add(model.onDidNavigate(() => this._refresh(false, true)));
		this._modelStore.add(model.onDidChangeLoadingState(() => this._refresh(false, true)));
		this._modelStore.add(model.onWillDispose(() => this._detachModel(true)));
		this._refresh();
		void this._captureScreenshot();
	}

	private _detachModel(modelDisposing = false): void {
		this._screenshotSequence++;
		const model = this._model;
		if (model && !modelDisposing) {
			void model.setVisible(false).catch(error => this.logService.error('Failed to hide detached browser view', error));
		}
		this._model = undefined;
		this._showPendingLayout = false; // PARA-PATCH: nothing left to show
		this._modelStore.clear();
		this._screenshotHandle.clear();
		this._cancelFocusTimeout();
		this._setBackgroundImage(undefined);
		this._refresh();
	}

	override dispose(): void {
		this._detachModel();
		super.dispose();
	}

	private _shouldShowPage(): boolean {
		return this._editorVisible
			&& !this._overlayObscured
			&& !!this._model?.url
			&& !this._model.error;
	}

	/**
	 * @param boundsArePushed the caller already pushed current bounds to main, so the page
	 * can be shown without laying out again (PARA-PATCH).
	 */
	private _refresh(boundsArePushed = false, restartScreenshot = false): void { // PARA-PATCH: fork's boundsArePushed first; upstream's restartScreenshot moved to the second argument
		if (restartScreenshot) {
			this._screenshotSequence++;
		}
		if (this._model?.error) {
			this._screenshotHandle.clear();
			this._setBackgroundImage(undefined);
		}
		const placeholderActive = !!this._model?.url && !this._model.error;
		this._placeholderScreenshot.style.display = placeholderActive ? '' : 'none';
		const pauseActive = !!this._model?.url && this._editorVisible && this._overlayObscured;
		this._overlayPauseElement.classList.toggle('visible', pauseActive);
		if (!this._model) {
			return;
		}
		const show = this._shouldShowPage();
		if (show === this._model.visible) {
			if (show && restartScreenshot) {
				void this._captureScreenshot();
			}
			return;
		}
		if (show) {
			// PARA-PATCH: push current bounds before showing. Main still holds the bounds this
			// view was last laid out at — which, when a space switch restores it into a
			// different pane, is a different (often much larger) rectangle — and it applies
			// `setVisible` the moment it arrives. Both calls travel the same channel, so
			// laying out first makes main resize before it draws. Without this the page is
			// painted at its old size for a frame or two on every restore.
			if (!boundsArePushed && !this._pushBounds()) {
				// Container isn't measured yet; the layout retries on the next frame and
				// layout() picks the show back up once bounds are current.
				this._showPendingLayout = true;
				return;
			}
			this._showPendingLayout = false;
			void this._model.setVisible(true);
			const targetDocument = this.targetWindow.document;
			// PARA-PATCH: not when the user's last press was outside the container (Para Code)
			if (targetDocument.hasFocus() && targetDocument.activeElement === this._container && this._paradisFocusGuard.mayFocusOnShow()) {
				this.tryFocus();
			}
		} else {
			// PARA-PATCH: hiding cancels a show that was waiting for layout
			this._showPendingLayout = false;
			void this._captureScreenshot();
			this.targetWindow.requestAnimationFrame(() => {
				if (this._model && !this._shouldShowPage()) {
					void this._model.setVisible(false);
				}
			});
		}
	}

	/**
	 * PARA-PATCH: lay the container out and report whether bounds reached main. Guarded so the
	 * layout() this triggers doesn't re-enter _refresh() mid-show. Without a pusher the bounds are
	 * left to the owner's own layout, as upstream does.
	 */
	private _pushBounds(): boolean {
		if (!this._paradisBoundsPusher) {
			return true;
		}
		this._pushingBounds = true;
		try {
			return this._paradisBoundsPusher();
		} finally {
			this._pushingBounds = false;
		}
	}

	private _refreshOverlayObscured(): void {
		if (!this._container) {
			return;
		}
		const overlays = this._overlayManager.getOverlappingOverlays(this._container);
		const obscured = overlays.length > 0;
		this._overlayPauseElement.classList.toggle('show-message', overlays.some(overlay => overlay.type === BrowserOverlayType.Notification));
		if (obscured !== this._overlayObscured) {
			this._overlayObscured = obscured;
			this._refresh();
		}
	}

	private async _captureScreenshot(periodic = false): Promise<void> { // PARA-PATCH: `periodic` marks the timer tick
		this._screenshotHandle.clear();
		const model = this._model;
		const sequence = this._screenshotSequence;
		if (!model?.url || model.error || !model.visible) {
			return;
		}
		// PARA-PATCH: this loop captured a full-resolution JPEG every second for as long as a browser
		// tab was on screen (70+ captures a minute in the field), and each capture occupied the view's
		// serialized screenshot queue that agent screenshots also wait on. The image is only a
		// placeholder for the moment the view hides, and the hide path in _refresh() takes a fresh one
		// anyway (that call is not periodic, so it still captures while the window is hidden), so the
		// timer tick skips while the window itself is hidden and refreshes less often.
		if (!periodic || this.targetWindow.document.visibilityState !== 'hidden') {
			try {
				const screenshot = await model.captureScreenshot({ quality: 80 });
				if (this._model === model && sequence === this._screenshotSequence && !model.error) {
					this._setBackgroundImage(screenshot);
				}
			} catch (error) {
				if (this._model === model && model.visible && !this._store.isDisposed) {
					this.logService.error('Failed to capture browser view screenshot', error);
				}
			}
		}
		if (this._model === model && sequence === this._screenshotSequence && !model.error && !this._store.isDisposed) {
			const handle = setTimeout(() => void this._captureScreenshot(true), 5000); // PARA-PATCH: was 1000
			this._screenshotHandle.value = toDisposable(() => clearTimeout(handle));
		}
	}

	private _setBackgroundImage(buffer: VSBuffer | undefined): void {
		this._placeholderScreenshot.style.backgroundImage = buffer
			? `url('data:image/jpeg;base64,${encodeBase64(buffer)}')`
			: '';
	}

	private async _handleKeyEvent(keyEvent: IBrowserViewKeyDownEvent): Promise<void> {
		if (!this._container) {
			return;
		}
		try {
			const event = new StandardKeyboardEvent(new KeyboardEvent('keydown', keyEvent));
			this.keybindingService.dispatchEvent(event, this._container);
		} catch (error) {
			this.logService.error('Failed to dispatch browser view key event', error);
		}
	}

	private _cancelFocusTimeout(): void {
		this._paradisFocusGuard.notePendingFocusSettled(); // PARA-PATCH (Para Code)
		if (this._focusTimeout) {
			clearTimeout(this._focusTimeout);
			this._focusTimeout = undefined;
		}
	}
}
