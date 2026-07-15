/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
