/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { WebContents, WebFrameMain } from 'electron';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { BrowserViewAutomationKeyExpectationQueue, browserViewAutomationKeySignatureFromCdp, browserViewAutomationKeySignatureFromElectron, browserViewAutomationNavigationDiscardsPreloadState, browserViewAutomationAwaitedFrames, browserViewAutomationFrameKind, browserViewAutomationFormatFrameKinds, type BrowserViewAutomationKeyFailureReason, type IBrowserViewAutomationKeyFailureDetail, type IBrowserViewAutomationKeyRegistration, type IBrowserViewAutomationKeySignature } from '../common/paraBrowserViewAutomationInput.js';

// Bound how long the main process waits for preload acks and track per-sequence automation key acks in flight (Para Browser MCP automation input isolation). The ack is answered on the page's main thread, so a page busy for a moment after a click must not fail the key (1s failed about 8% of agent keystrokes)
const BROWSER_VIEW_AUTOMATION_KEY_ACK_TIMEOUT_MS = 2_500;

interface IPendingAutomationKeyAck {
	readonly phase: 'register' | 'activate';
	readonly frames: readonly WebFrameMain[];
	/** The frames whose ack is waited for (see browserViewAutomationAwaitedFrames). Acks from the other frames are still counted. */
	readonly awaited: readonly WebFrameMain[];
	readonly acknowledged: Set<WebFrameMain>;
	readonly resolve: (accepted: boolean) => void;
	readonly timer: ReturnType<typeof setTimeout>;
	/** Why the ack failed, set before resolving with false. */
	failure?: BrowserViewAutomationKeyFailureReason;
}

/**
 * Automation key isolation for one BrowserView (Para Browser MCP automation input isolation):
 * prepare/activate/commit/complete/cancel an exact keystroke across all live preload frames with
 * acks, plus focus-authority capture and the frame/expectation cleanup helpers, so injected CDP keys
 * are delivered exactly once and never confused with real user input. BrowserView owns one of these
 * and calls into it from its WebContents listeners (browserView.ts, PARA-PATCH).
 */
export class ParaBrowserViewAutomationKeys extends Disposable {
	private readonly _automationKeyExpectations = this._register(new BrowserViewAutomationKeyExpectationQueue(sequence => this._automationKeyFrames.delete(sequence)));
	private readonly _pendingAutomationKeyAcks = new Map<number, IPendingAutomationKeyAck>();
	private readonly _automationKeyFrames = new Map<number, readonly WebFrameMain[]>();
	/** Frames whose preload announced itself (`preloadReady`) or answered an automation key at least once. */
	private readonly _automationPreloadFrames = new WeakSet<WebFrameMain>();
	private _automationKeySequence = 0;
	private _automationInputFocusAuthority: object = Object.freeze({});

	/**
	 * @param getWebContents the view's WebContents, read on every use (the view creates it after its fields)
	 * @param getIsDisposed whether the view has been disposed
	 */
	constructor(
		private readonly getWebContents: () => WebContents,
		private readonly getIsDisposed: () => boolean,
		private readonly logService: ILogService,
	) {
		super();
	}

	private get webContents(): WebContents {
		return this.getWebContents();
	}

	private get _isDisposed(): boolean {
		return this.getIsDisposed();
	}

	/** Real user focus rotates the input authority and invalidates any pending automation key so injected input can never masquerade as user input. */
	onFocus(): void {
		this._automationInputFocusAuthority = Object.freeze({});
		this.invalidateAutomationKeyExpectationsForUserFocus();
	}

	/** Rotate the input authority on blur so a stale authority can never authorize a later automation key. */
	onBlur(): void {
		this._automationInputFocusAuthority = Object.freeze({});
	}

	/** Navigation discards the preload's isolated state, so clear any pending automation key expectations; same-document navigations keep it. */
	onDidStartNavigation(details: unknown): void {
		if (browserViewAutomationNavigationDiscardsPreloadState(details)) {
			this.clearAutomationKeyExpectations();
		}
	}

	/** Whether `input` matches an active automation expectation and must be swallowed before the direct-forward path, so injected keys are not delivered as workbench key commands. */
	consumeBeforeInputEvent(input: unknown): boolean {
		const automationSignature = browserViewAutomationKeySignatureFromElectron(input);
		return !!automationSignature && this._automationKeyExpectations.consume(automationSignature, 'before-input-event') !== undefined;
	}

	/** Handle preload acks for automation key register/activate and preload-consumed notifications, validating sender frame, sequence and signature before mutating expectation state. */
	handleIpcMessage(event: object, channel: string, payload: unknown): void {
		const senderFrame = (event as { senderFrame?: WebFrameMain }).senderFrame;
		if (senderFrame && channel === 'vscode:browserView:preloadReady') {
			// The preload's keydown listener is set up in the same synchronous init that sends this
			// (its payload is the frame token, a string).
			this._automationPreloadFrames.add(senderFrame);
			return;
		}
		if (!senderFrame || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
			return;
		}
		const record = payload as Readonly<Record<string, unknown>>;
		if (channel === 'vscode:browserView:automationKeyExpected' || channel === 'vscode:browserView:automationKeyActivated') {
			const sequence = record.sequence;
			if (!Number.isSafeInteger(sequence) || (sequence as number) <= 0 || typeof record.accepted !== 'boolean') {
				return;
			}
			const pending = this._pendingAutomationKeyAcks.get(sequence as number);
			const expectedPhase = channel === 'vscode:browserView:automationKeyExpected' ? 'register' : 'activate';
			if (!pending || pending.phase !== expectedPhase || !pending.frames.includes(senderFrame)) {
				return;
			}
			if (!record.accepted) {
				pending.failure ??= 'rejected';
				pending.resolve(false);
				return;
			}
			pending.acknowledged.add(senderFrame);
			this._automationPreloadFrames.add(senderFrame);
			if (pending.awaited.every(frame => pending.acknowledged.has(frame))) {
				pending.resolve(true);
			}
		} else if (channel === 'vscode:browserView:automationKeyConsumed') {
			const sequence = record.sequence;
			const signature = browserViewAutomationKeySignatureFromCdp(record.signature);
			const frames = Number.isSafeInteger(sequence) ? this._automationKeyFrames.get(sequence as number) : undefined;
			if (Number.isSafeInteger(sequence) && signature && frames?.includes(senderFrame)) {
				const consumed = this._automationKeyExpectations.consume(signature, 'preload-keydown', sequence as number);
				if (consumed !== sequence) {
					try {
						this.logService.warn('Ignored mismatched BrowserView automation key consumption acknowledgement.');
					} catch {
						// Diagnostics must never change input delivery or suppression state.
					}
				}
			}
		}
	}

	/** Opaque Main-local authority that changes on every focus or blur transition. */
	captureAutomationInputFocusAuthority(): object | undefined {
		if (this._isDisposed || this.webContents.isDestroyed()) {
			return undefined;
		}
		return this._automationInputFocusAuthority;
	}

	/**
	 * Register one exact automation key signature in every currently live preload before CDP dispatch.
	 * `onFailure` receives why registration or the later activation failed (for diagnostics only).
	 */
	async prepareAutomationKeyInput(signature: IBrowserViewAutomationKeySignature, onFailure?: (reason: BrowserViewAutomationKeyFailureReason, phase: 'register' | 'activate', detail?: IBrowserViewAutomationKeyFailureDetail) => void): Promise<IBrowserViewAutomationKeyRegistration | undefined> {
		const fail = (reason: BrowserViewAutomationKeyFailureReason, phase: 'register' | 'activate', detail?: IBrowserViewAutomationKeyFailureDetail): void => {
			try {
				onFailure?.(reason, phase, detail);
			} catch {
				// Diagnostics must never change input delivery or suppression state.
			}
		};
		if (this._isDisposed || this.webContents.isDestroyed()) {
			fail('view-unavailable', 'register');
			return undefined;
		}
		const frames = this.getLiveAutomationFrames();
		if (frames.length === 0) {
			fail('no-frames', 'register');
			return undefined;
		}
		const sequence = this.nextAutomationKeySequence();
		if (sequence === undefined || !this._automationKeyExpectations.register({ sequence, signature })) {
			fail('expectation-limit', 'register');
			return undefined;
		}

		let resolveAck!: (accepted: boolean) => void;
		const ack = new Promise<boolean>(resolve => resolveAck = resolve);
		const awaited = this.getAwaitedAutomationFrames(frames);
		const pending: IPendingAutomationKeyAck = {
			phase: 'register',
			frames,
			awaited,
			acknowledged: new Set(),
			resolve: resolveAck,
			timer: setTimeout(() => {
				pending.failure ??= 'ack-timeout';
				resolveAck(false);
			}, BROWSER_VIEW_AUTOMATION_KEY_ACK_TIMEOUT_MS),
		};
		this._pendingAutomationKeyAcks.set(sequence, pending);
		const nativeFocused = this.isNativeFocusedForAutomation();
		try {
			for (const frame of frames) {
				frame.postMessage('vscode:browserView:expectAutomationKey', { sequence, signature, nativeFocused });
			}
		} catch {
			resolveAck(false);
		}
		if (awaited.length === 0) {
			// No frame has a preload yet, so none can forward the key; the commit re-checks before sending.
			resolveAck(true);
		}

		const accepted = await ack;
		clearTimeout(pending.timer);
		if (this._pendingAutomationKeyAcks.get(sequence) === pending) {
			this._pendingAutomationKeyAcks.delete(sequence);
		}
		const registered = pending.acknowledged;
		if (!accepted || !this._automationKeyExpectations.has(sequence) || !this.isAutomationFocusPathCovered(registered)) {
			fail(!accepted ? pending.failure ?? 'cancelled' : !this._automationKeyExpectations.has(sequence) ? 'cleared' : 'frames-changed', 'register', pending.failure === 'ack-timeout' ? this.describeUnansweredAutomationFrames(pending) : undefined);
			this._automationKeyExpectations.cancel(sequence);
			this.cancelPreloadAutomationKey(frames, sequence);
			return undefined;
		}
		this._automationKeyFrames.set(sequence, frames);
		// Frames that were not waited for and had not answered yet may still register the key later. They
		// are never activated, and an inactive expectation is not dropped by `complete`, so it would pile up
		// in their preload until it refused new keys; cancel it there now (same-frame messages stay in order).
		this.cancelPreloadAutomationKey(frames.filter(frame => !registered.has(frame)), sequence);
		let settled = false;
		let activationStarted = false;
		let activated = false;
		let activatedFrames: ReadonlySet<WebFrameMain> = new Set();
		return Object.freeze({
			sequence,
			activate: async () => {
				if (settled || activationStarted || this._isDisposed || this.webContents.isDestroyed()
					|| !this._automationKeyExpectations.has(sequence)
					|| this._automationKeyFrames.get(sequence) !== frames || !this.isAutomationFocusPathCovered(registered)) {
					fail(settled || activationStarted ? 'cancelled' : this._isDisposed || this.webContents.isDestroyed() ? 'view-unavailable' : !this._automationKeyExpectations.has(sequence) ? 'cleared' : 'frames-changed', 'activate');
					return false;
				}
				try {
					if (this.webContents.isFocused()) {
						fail('user-focus', 'activate');
						return false;
					}
				} catch {
					fail('view-unavailable', 'activate');
					return false;
				}
				activationStarted = true;
				let resolveActivationAck!: (accepted: boolean) => void;
				const activationAck = new Promise<boolean>(resolve => resolveActivationAck = resolve);
				// Only the frames that registered the key can activate it; a frame that never saw the
				// registration would refuse the activation.
				const activationFrames = frames.filter(frame => registered.has(frame));
				const activationAwaited = this.getAwaitedAutomationFrames(activationFrames);
				const activationPending: IPendingAutomationKeyAck = {
					phase: 'activate',
					frames: activationFrames,
					awaited: activationAwaited,
					acknowledged: new Set(),
					resolve: resolveActivationAck,
					timer: setTimeout(() => {
						activationPending.failure ??= 'ack-timeout';
						resolveActivationAck(false);
					}, BROWSER_VIEW_AUTOMATION_KEY_ACK_TIMEOUT_MS),
				};
				this._pendingAutomationKeyAcks.set(sequence, activationPending);
				const activationNativeFocused = this.isNativeFocusedForAutomation();
				try {
					for (const frame of activationFrames) {
						frame.postMessage('vscode:browserView:activateAutomationKey', { sequence, nativeFocused: activationNativeFocused });
					}
				} catch {
					resolveActivationAck(false);
				}
				if (activationAwaited.length === 0) {
					resolveActivationAck(true);
				}
				const accepted = await activationAck;
				clearTimeout(activationPending.timer);
				if (this._pendingAutomationKeyAcks.get(sequence) === activationPending) {
					this._pendingAutomationKeyAcks.delete(sequence);
				}
				if (!accepted || settled || !this._automationKeyExpectations.has(sequence)
					|| this._automationKeyFrames.get(sequence) !== frames || !this.isAutomationFocusPathCovered(activationPending.acknowledged)) {
					fail(!accepted ? activationPending.failure ?? 'cancelled' : settled ? 'cancelled' : !this._automationKeyExpectations.has(sequence) ? 'cleared' : 'frames-changed', 'activate', activationPending.failure === 'ack-timeout' ? this.describeUnansweredAutomationFrames(activationPending) : undefined);
					return false;
				}
				activatedFrames = activationPending.acknowledged;
				// Same as after the registration: a frame that activates late keeps no stale expectation.
				this.cancelPreloadAutomationKey(activationFrames.filter(frame => !activatedFrames.has(frame)), sequence);
				if (!this._automationKeyExpectations.activate(sequence)) {
					fail('cleared', 'activate');
					return false;
				}
				activated = true;
				return true;
			},
			commit: () => {
				if (settled || !activated) {
					return false;
				}
				// The focus may have moved to a frame that did not activate the key while it was prepared.
				if (!this.isAutomationFocusPathCovered(activatedFrames)) {
					fail('frames-changed', 'activate');
					return false;
				}
				return this._automationKeyExpectations.commit(sequence);
			},
			complete: () => {
				if (settled) {
					return;
				}
				settled = true;
				this._automationKeyExpectations.complete(sequence);
				for (const frame of frames) {
					try {
						if (!frame.detached && !frame.isDestroyed()) {
							frame.postMessage('vscode:browserView:completeAutomationKey', { sequence });
						}
					} catch {
						// A navigated or detached frame already discarded its isolated preload state.
					}
				}
			},
			cancel: () => {
				if (settled) {
					return;
				}
				settled = true;
				this._automationKeyExpectations.cancel(sequence);
				this.cancelPreloadAutomationKey(frames, sequence);
			},
		});
	}

	/**
	 * Whether the user really has this view focused, from the browser process' point of view.
	 *
	 * The preload cannot answer this on its own: Chromium's DevTools input handler calls
	 * `RenderWidgetHost::Focus()` on every injected `Input.*` event, so `document.hasFocus()`
	 * turns true the first time an agent clicks or types and never turns back off. Judging user
	 * focus by that value makes every automated keystroke after the first one look like real user
	 * input and get rejected. The native first responder stayed false throughout injection when
	 * measured, so it is used as the honest signal. Uncertainty resolves to `true` so a possible
	 * real user event is never suppressed.
	 */
	private isNativeFocusedForAutomation(): boolean {
		try {
			return this.webContents.isFocused();
		} catch {
			return true;
		}
	}

	private nextAutomationKeySequence(): number | undefined {
		for (let attempt = 0; attempt < Number.MAX_SAFE_INTEGER; attempt++) {
			this._automationKeySequence = this._automationKeySequence >= Number.MAX_SAFE_INTEGER ? 1 : this._automationKeySequence + 1;
			if (!this._pendingAutomationKeyAcks.has(this._automationKeySequence)
				&& !this._automationKeyFrames.has(this._automationKeySequence)) {
				return this._automationKeySequence;
			}
		}
		return undefined;
	}

	private getLiveAutomationFrames(): readonly WebFrameMain[] {
		try {
			return this.webContents.mainFrame.framesInSubtree.filter(frame => !frame.detached && !frame.isDestroyed());
		} catch {
			return [];
		}
	}

	/** The focused frame and its ancestors up to the top frame, or undefined when the focused frame is unknown. */
	private getAutomationFocusPath(): readonly WebFrameMain[] | undefined {
		try {
			const path: WebFrameMain[] = [];
			for (let frame: WebFrameMain | null = this.webContents.focusedFrame; frame && path.length < 64; frame = frame.parent) {
				path.push(frame);
			}
			return path.length > 0 ? path : undefined;
		} catch {
			return undefined;
		}
	}

	private getAwaitedAutomationFrames(frames: readonly WebFrameMain[]): readonly WebFrameMain[] {
		let top: WebFrameMain | undefined;
		try {
			const mainFrame = this.webContents.mainFrame;
			top = mainFrame.url === '' || mainFrame.url.startsWith('about:') ? undefined : mainFrame;
		} catch {
			top = undefined;
		}
		return browserViewAutomationAwaitedFrames(frames, frame => this._automationPreloadFrames.has(frame), this.getAutomationFocusPath(), top);
	}

	/**
	 * Whether every frame that must hold the key right now (see getAwaitedAutomationFrames, read
	 * again from the live frames and the current focus) is among `acknowledged`. Replaces the
	 * former "the same frames are still live" check: frames that come and go elsewhere on the page
	 * (ads, about:blank iframes) cannot receive the key, but a focus move to a frame that did not
	 * answer can.
	 */
	private isAutomationFocusPathCovered(acknowledged: ReadonlySet<WebFrameMain>): boolean {
		return this.getAwaitedAutomationFrames(this.getLiveAutomationFrames()).every(frame => acknowledged.has(frame));
	}

	/** Which awaited frames did not answer, by kind, without their URLs. */
	private describeUnansweredAutomationFrames(pending: IPendingAutomationKeyAck): IBrowserViewAutomationKeyFailureDetail | undefined {
		try {
			const topOrigin = this.webContents.mainFrame.origin;
			const kindOf = (frame: WebFrameMain) => {
				try {
					return browserViewAutomationFrameKind(frame.url, frame.origin, topOrigin);
				} catch {
					return 'about-blank' as const;
				}
			};
			return {
				unansweredFrames: browserViewAutomationFormatFrameKinds(pending.awaited.filter(frame => !pending.acknowledged.has(frame)).map(kindOf)),
				awaitedFrames: pending.awaited.length,
				framesWithoutPreload: pending.frames.filter(frame => !this._automationPreloadFrames.has(frame)).length,
			};
		} catch {
			return undefined;
		}
	}

	clearAutomationKeyExpectations(): void {
		for (const [sequence, pending] of this._pendingAutomationKeyAcks) {
			clearTimeout(pending.timer);
			pending.failure ??= 'cleared';
			pending.resolve(false);
			this.cancelPreloadAutomationKey(pending.frames, sequence);
		}
		for (const [sequence, frames] of this._automationKeyFrames) {
			this.cancelPreloadAutomationKey(frames, sequence);
		}
		this._pendingAutomationKeyAcks.clear();
		this._automationKeyExpectations.clear();
		this._automationKeyFrames.clear();
	}

	private invalidateAutomationKeyExpectationsForUserFocus(): void {
		for (const [sequence, pending] of this._pendingAutomationKeyAcks) {
			clearTimeout(pending.timer);
			pending.failure ??= 'user-focus';
			pending.resolve(false);
			this.cancelPreloadAutomationKey(pending.frames, sequence);
			this._automationKeyExpectations.invalidateForUserFocus(sequence);
		}
		this._pendingAutomationKeyAcks.clear();
		for (const [sequence, frames] of [...this._automationKeyFrames]) {
			this._automationKeyExpectations.invalidateForUserFocus(sequence);
			this.cancelPreloadAutomationKey(frames, sequence);
		}
	}

	private cancelPreloadAutomationKey(frames: readonly WebFrameMain[], sequence: number): void {
		for (const frame of frames) {
			try {
				if (!frame.detached && !frame.isDestroyed()) {
					frame.postMessage('vscode:browserView:cancelAutomationKey', { sequence });
				}
			} catch {
				// Detached and navigating frames discard their isolated preload state themselves.
			}
		}
	}
}
