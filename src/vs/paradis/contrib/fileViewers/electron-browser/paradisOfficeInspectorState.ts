/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel と Word の「変更点」のパネル（paradisSpreadsheetChangeInspector.ts・paradisWordChangeInspector.ts）で
// 同じだった、入力の開き直しと表示状態の復元の部品。表示状態の中身（ズーム・シート・表示モードなど）は版ごとに違うので、
// その写し方と検査は各版に残す。

import type { ParadisOfficeSourceDescriptor } from '../common/paradisOfficeProtocol.js';

/** Input-open fence: only the newest open may commit or restore editor state. */
export class ParadisOfficeOpenGeneration {
	private generation = 0;

	begin(): number {
		return ++this.generation;
	}

	invalidate(): void {
		this.generation++;
	}

	isCurrent(generation: number): boolean {
		return generation === this.generation;
	}
}

export interface ParadisOfficeDataRecord {
	readonly values: ReadonlyMap<string, unknown>;
	readonly keys: readonly string[];
}

/** 素のオブジェクト（プロトタイプなし・文字列の鍵・列挙できる値の欄だけ・鍵は maximumKeys 個まで）だけを読む。それ以外は undefined。 */
export function paradisOfficeDataRecord(value: unknown, maximumKeys: number): ParadisOfficeDataRecord | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			return undefined;
		}
		const ownKeys = Reflect.ownKeys(value);
		if (ownKeys.length > maximumKeys || ownKeys.some(key => typeof key !== 'string')) {
			return undefined;
		}
		const keys = ownKeys as string[];
		const values = new Map<string, unknown>();
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return undefined;
			}
			values.set(key, descriptor.value);
		}
		return { keys, values };
	} catch {
		return undefined;
	}
}

export function paradisCopyOfficeSource(source: ParadisOfficeSourceDescriptor): ParadisOfficeSourceDescriptor {
	return Object.freeze({
		kind: source.kind,
		...(source.uri ? { uri: source.uri } : {}),
		...(source.revisionHint ? { revisionHint: source.revisionHint } : {}),
		displayName: source.displayName,
		...(source.side ? { side: source.side } : {}),
	});
}

export interface ParadisOfficeRestorableInput<TViewState> {
	readonly source: ParadisOfficeSourceDescriptor;
	readonly viewState: TViewState;
}

/** Two-phase input state used by rapid input switches. Cancel always returns the last committed descriptor/view state. */
export class ParadisOfficeInputRestoration<TViewState> {
	private committed: ParadisOfficeRestorableInput<TViewState>;
	private pending: ParadisOfficeRestorableInput<TViewState> | undefined;

	/** @param copyViewState 表示状態の凍った写しを作る（版ごとの欄を持つ） */
	constructor(initial: ParadisOfficeRestorableInput<TViewState>, private readonly copyViewState: (state: TViewState) => TViewState) {
		this.committed = this.copyInput(initial);
	}

	begin(input: ParadisOfficeRestorableInput<TViewState>): void {
		this.pending = this.copyInput(input);
	}

	commit(viewState?: TViewState): ParadisOfficeRestorableInput<TViewState> {
		if (this.pending) {
			this.committed = this.copyInput({ source: this.pending.source, viewState: viewState ?? this.pending.viewState });
			this.pending = undefined;
		}
		return this.copyInput(this.committed);
	}

	cancel(): ParadisOfficeRestorableInput<TViewState> {
		this.pending = undefined;
		return this.copyInput(this.committed);
	}

	snapshot(): ParadisOfficeRestorableInput<TViewState> {
		return this.copyInput(this.committed);
	}

	serialize(): string {
		return JSON.stringify(this.committed);
	}

	private copyInput(input: ParadisOfficeRestorableInput<TViewState>): ParadisOfficeRestorableInput<TViewState> {
		return Object.freeze({ source: paradisCopyOfficeSource(input.source), viewState: this.copyViewState(input.viewState) });
	}
}
