/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ペインとアプリの組ごとの許可の台帳（設計書 3.5）。shared process のメモリだけに持ち、ディスクに書かない。
// Para Code を再起動すると全ペインで聞き直しになる。
//
// ペインが閉じたことはプロバイダへ知らされないので、行は古いものから上限で捨てる。ペイントークンは推測できない
// 乱数で、閉じたペインのトークンが再び使われることはないため、残った行が別のペインに効くことはない。

import { ParadisComputerUseGrant } from '../common/paradisComputerUse.js';

const DEFAULT_MAX_ENTRIES = 1_000;

export interface IParadisComputerUseGrantEntry {
	readonly bundleId: string;
	readonly grant: ParadisComputerUseGrant;
}

export class ParadisComputerUseGrantLedger {
	/** `<ペイントークン>\n<bundle id（小文字）>` → 決定。挿入順を古い順として使う。 */
	private readonly _entries = new Map<string, { readonly bundleId: string; readonly grant: ParadisComputerUseGrant }>();

	constructor(private readonly _maxEntries: number = DEFAULT_MAX_ENTRIES) { }

	get(paneToken: string, bundleId: string): ParadisComputerUseGrant | undefined {
		return this._entries.get(keyOf(paneToken, bundleId))?.grant;
	}

	set(paneToken: string, bundleId: string, grant: ParadisComputerUseGrant): void {
		const key = keyOf(paneToken, bundleId);
		this._entries.delete(key);
		this._entries.set(key, { bundleId, grant });
		while (this._entries.size > this._maxEntries) {
			const oldest = this._entries.keys().next();
			if (oldest.done) {
				break;
			}
			this._entries.delete(oldest.value);
		}
	}

	/** そのペインの決定の一覧（決めた順）。 */
	listForPane(paneToken: string): IParadisComputerUseGrantEntry[] {
		const prefix = `${paneToken}\n`;
		const result: IParadisComputerUseGrantEntry[] = [];
		for (const [key, entry] of this._entries) {
			if (key.startsWith(prefix)) {
				result.push({ bundleId: entry.bundleId, grant: entry.grant });
			}
		}
		return result;
	}

	forgetPane(paneToken: string): void {
		const prefix = `${paneToken}\n`;
		for (const key of [...this._entries.keys()]) {
			if (key.startsWith(prefix)) {
				this._entries.delete(key);
			}
		}
	}

	clear(): void {
		this._entries.clear();
	}
}

function keyOf(paneToken: string, bundleId: string): string {
	return `${paneToken}\n${bundleId.toLowerCase()}`;
}
