/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable } from '../../../base/common/lifecycle.js';

export const BROWSER_VIEW_AUTOMATION_KEY_EXPECTATION_LIMIT = 32;
export const BROWSER_VIEW_AUTOMATION_KEY_EXPECTATION_TTL_MS = 250;

export interface IBrowserViewAutomationKeySignature {
	readonly type: 'keyDown' | 'keyUp' | 'char';
	readonly key: string;
	readonly code: string;
	readonly location: number;
	readonly modifiers: number;
	readonly repeat: boolean;
}

export interface IBrowserViewAutomationKeyExpectation {
	readonly sequence: number;
	readonly signature: IBrowserViewAutomationKeySignature;
}

export interface IBrowserViewAutomationKeyRegistration {
	readonly sequence: number;
	activate(): Promise<boolean>;
	commit(): boolean;
	complete(): void;
	cancel(): void;
}

export type BrowserViewAutomationKeyRoute = 'preload-keydown' | 'before-input-event';

/** Why an automation key could not be registered or activated. Carries no page data. */
export type BrowserViewAutomationKeyFailureReason =
	/** The view or its webContents is gone. */
	| 'view-unavailable'
	/** No live frame to register in. */
	| 'no-frames'
	/** Too many keys in flight. */
	| 'expectation-limit'
	/** A frame did not answer in time (its page's main thread was busy, or it has no preload). */
	| 'ack-timeout'
	/** A frame refused (the user was interacting with it). */
	| 'rejected'
	/** Pending keys were cleared by a navigation or a debugger detach. */
	| 'cleared'
	/** The view gained real user focus. */
	| 'user-focus'
	/** Frames were added or removed while the frames answered. */
	| 'frames-changed'
	/** The registration was cancelled or already used. */
	| 'cancelled';

/**
 * Whether a `did-start-navigation` discards the preload state that holds automation key expectations.
 * Same-document navigations (`history.pushState`, `replaceState`, fragment changes) keep the document and
 * its preload, so they must not cancel a key in flight: single-page apps do this on many clicks, and the
 * cancelled key surfaced to the agent as "automation key suppression could not be registered".
 */
export function browserViewAutomationNavigationDiscardsPreloadState(details: unknown): boolean {
	return !(isRecord(details) && details.isSameDocument === true);
}
/**
 * What kind of frame did not answer an automation key ack. A fixed word, so it can go into the
 * agent-facing error, the log and Sentry without carrying the frame's URL.
 */
export type BrowserViewAutomationFrameKind = 'same-origin' | 'cross-origin' | 'about-blank' | 'sandbox';

/** Classifies a frame against the top frame's origin (only the scheme and the origin are looked at). */
export function browserViewAutomationFrameKind(url: string, origin: string, topOrigin: string): BrowserViewAutomationFrameKind {
	if (url === '' || url.startsWith('about:')) {
		return 'about-blank';
	}
	if (origin === 'null' || origin === '') {
		// An opaque origin: a sandboxed iframe (or a data: URL, which is sandbox-like for this purpose).
		return 'sandbox';
	}
	return origin === topOrigin ? 'same-origin' : 'cross-origin';
}

/** `same-origin=1,about-blank=2` in a fixed order (empty when there are none). */
export function browserViewAutomationFormatFrameKinds(kinds: readonly BrowserViewAutomationFrameKind[]): string {
	const order: readonly BrowserViewAutomationFrameKind[] = ['same-origin', 'cross-origin', 'about-blank', 'sandbox'];
	return order
		.map(kind => [kind, kinds.filter(value => value === kind).length] as const)
		.filter(([, count]) => count > 0)
		.map(([kind, count]) => `${kind}=${count}`)
		.join(',');
}

/** Facts about the frames of a failed automation key ack, for diagnostics only (no page data). */
export interface IBrowserViewAutomationKeyFailureDetail {
	/** Frames whose answer was waited for and did not come, by kind (`same-origin=1,...`). */
	readonly unansweredFrames: string;
	/** How many answers were waited for. */
	readonly awaitedFrames: number;
	/** Frames that never loaded the preload (about:blank and the like); they were not waited for. */
	readonly framesWithoutPreload: number;
}

/**
 * The frames whose ack an automation key waits for, out of every live frame it is sent to.
 *
 * A keystroke is delivered to the focused frame only (key events do not cross frame boundaries), so
 * only the preload of the focused frame can see it; the ancestors are waited for as well so a focus
 * move up the tree is still covered. Frames whose preload never announced itself (about:blank
 * iframes never run it, measured) have no keydown listener, so they cannot forward the key and are
 * not waited for. When the focused frame is unknown, every frame with a preload is waited for.
 *
 * `focusPath` is the focused frame followed by its ancestors up to the top frame, or undefined when
 * it could not be read. When nothing would be waited for, `fallback` (the top frame unless it shows
 * about:blank) is: a view that adopted an already loaded page may have missed its announcement.
 */
export function browserViewAutomationAwaitedFrames<T>(frames: readonly T[], hasPreload: (frame: T) => boolean, focusPath: readonly T[] | undefined, fallback?: T): readonly T[] {
	const withPreload = frames.filter(hasPreload);
	const awaited = focusPath === undefined || focusPath.length === 0 ? withPreload : withPreload.filter(frame => focusPath.includes(frame));
	if (awaited.length === 0 && fallback !== undefined && frames.includes(fallback)) {
		return [fallback];
	}
	return awaited;
}

export type BrowserViewAutomationTrustedFocusPredicate = (value: unknown) => boolean;

interface IExpectationState extends IBrowserViewAutomationKeyExpectation {
	activated: boolean;
	committed: boolean;
	preloadConsumed: boolean;
	beforeInputConsumed: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const browserViewAutomationIsTrustedFocusEvent: BrowserViewAutomationTrustedFocusPredicate = value =>
	isRecord(value) && value.isTrusted === true;

function isKeyIdentity(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 128;
}

function isLocation(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3;
}

function isModifiers(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 15;
}

function signature(type: unknown, key: unknown, code: unknown, location: unknown, modifiers: unknown, repeat: unknown): IBrowserViewAutomationKeySignature | undefined {
	if ((type !== 'keyDown' && type !== 'keyUp' && type !== 'char')
		|| !isKeyIdentity(key)
		|| !isKeyIdentity(code)
		|| !isLocation(location)
		|| !isModifiers(modifiers)
		|| typeof repeat !== 'boolean') {
		return undefined;
	}
	return Object.freeze({ type, key, code, location, modifiers, repeat });
}

export function browserViewAutomationKeySignatureFromCdp(value: unknown): IBrowserViewAutomationKeySignature | undefined {
	if (!isRecord(value) || !['rawKeyDown', 'keyDown', 'keyUp', 'char'].includes(value.type as string)) {
		return undefined;
	}
	return signature(
		value.type === 'rawKeyDown' ? 'keyDown' : value.type,
		value.key,
		value.code,
		value.location ?? 0,
		value.modifiers ?? 0,
		value.autoRepeat ?? false,
	);
}

export function browserViewAutomationKeySignatureFromElectron(value: unknown): IBrowserViewAutomationKeySignature | undefined {
	if (!isRecord(value) || value.type !== 'keyDown') {
		return undefined;
	}
	const modifierFields = [value.alt, value.control, value.meta, value.shift];
	if (modifierFields.some(candidate => typeof candidate !== 'boolean')) {
		return undefined;
	}
	const modifiers = (value.alt ? 1 : 0)
		| (value.control ? 2 : 0)
		| (value.meta ? 4 : 0)
		| (value.shift ? 8 : 0);
	return signature('keyDown', value.key, value.code, value.location ?? 0, modifiers, value.isAutoRepeat ?? false);
}

export function browserViewAutomationKeySignatureFromPreload(value: unknown): IBrowserViewAutomationKeySignature | undefined {
	if (!isRecord(value) || value.type !== 'keydown') {
		return undefined;
	}
	const modifierFields = [value.altKey, value.ctrlKey, value.metaKey, value.shiftKey];
	if (modifierFields.some(candidate => typeof candidate !== 'boolean')) {
		return undefined;
	}
	const modifiers = (value.altKey ? 1 : 0)
		| (value.ctrlKey ? 2 : 0)
		| (value.metaKey ? 4 : 0)
		| (value.shiftKey ? 8 : 0);
	return signature('keyDown', value.key, value.code, value.location ?? 0, modifiers, value.repeat ?? false);
}

function signaturesEqual(left: IBrowserViewAutomationKeySignature, right: IBrowserViewAutomationKeySignature): boolean {
	return left.type === right.type
		&& left.key === right.key
		&& left.code === right.code
		&& left.location === right.location
		&& left.modifiers === right.modifiers
		&& left.repeat === right.repeat;
}

/**
 * Main-side expectation queue used to keep one automation key event out of both
 * shortcut forwarding routes without suppressing a similar real user event.
 */
export class BrowserViewAutomationKeyExpectationQueue implements IDisposable {
	private readonly expectations = new Map<number, IExpectationState>();
	private disposed = false;

	constructor(private readonly onDidRemoveExpectation?: (sequence: number) => void) { }

	get size(): number { return this.expectations.size; }

	register(expectation: IBrowserViewAutomationKeyExpectation): boolean {
		if (this.disposed
			|| !Number.isSafeInteger(expectation.sequence)
			|| expectation.sequence <= 0
			|| this.expectations.has(expectation.sequence)
			|| this.expectations.size >= BROWSER_VIEW_AUTOMATION_KEY_EXPECTATION_LIMIT) {
			return false;
		}
		this.expectations.set(expectation.sequence, {
			sequence: expectation.sequence,
			signature: expectation.signature,
			activated: false,
			committed: false,
			preloadConsumed: false,
			beforeInputConsumed: false,
			timer: undefined,
		});
		return true;
	}

	consume(signatureValue: IBrowserViewAutomationKeySignature, _route: BrowserViewAutomationKeyRoute, expectedSequence?: number): number | undefined {
		for (const expectation of this.expectations.values()) {
			if (expectedSequence !== undefined && expectation.sequence !== expectedSequence) {
				continue;
			}
			if (!expectation.committed || !signaturesEqual(expectation.signature, signatureValue)) {
				continue;
			}
			if (_route === 'preload-keydown') {
				if (expectation.preloadConsumed) {
					continue;
				}
				expectation.preloadConsumed = true;
			} else {
				if (expectation.beforeInputConsumed) {
					continue;
				}
				expectation.beforeInputConsumed = true;
			}
			return expectation.sequence;
		}
		return undefined;
	}

	activate(sequence: number): boolean {
		const expectation = this.expectations.get(sequence);
		if (!expectation || expectation.activated || expectation.committed || expectation.timer !== undefined) {
			return false;
		}
		expectation.activated = true;
		return true;
	}

	commit(sequence: number): boolean {
		const expectation = this.expectations.get(sequence);
		if (!expectation?.activated || expectation.committed || expectation.timer !== undefined) {
			return false;
		}
		expectation.committed = true;
		return true;
	}

	has(sequence: number): boolean {
		return this.expectations.has(sequence);
	}

	complete(sequence: number): boolean {
		const expectation = this.expectations.get(sequence);
		if (!expectation?.committed || expectation.timer !== undefined) {
			return false;
		}
		expectation.timer = setTimeout(() => {
			if (this.expectations.get(sequence) === expectation) {
				this.removeExpectation(sequence);
			}
		}, BROWSER_VIEW_AUTOMATION_KEY_EXPECTATION_TTL_MS);
		return true;
	}

	cancel(sequence: number): boolean {
		const expectation = this.expectations.get(sequence);
		if (!expectation) {
			return false;
		}
		if (expectation.timer !== undefined) {
			clearTimeout(expectation.timer);
		}
		return this.removeExpectation(sequence);
	}

	/** User focus wins even after dispatch commit; an identical physical key cannot be distinguished safely. */
	invalidateForUserFocus(sequence: number): boolean {
		return this.cancel(sequence);
	}

	private removeExpectation(sequence: number): boolean {
		if (!this.expectations.delete(sequence)) {
			return false;
		}
		try {
			this.onDidRemoveExpectation?.(sequence);
		} catch {
			// Cleanup callbacks are diagnostic bookkeeping and cannot retain an expectation.
		}
		return true;
	}

	clear(): void {
		for (const expectation of this.expectations.values()) {
			if (expectation.timer !== undefined) {
				clearTimeout(expectation.timer);
			}
		}
		for (const sequence of [...this.expectations.keys()]) {
			this.removeExpectation(sequence);
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.clear();
	}
}
