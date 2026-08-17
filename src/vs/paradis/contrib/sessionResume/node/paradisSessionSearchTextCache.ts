/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

interface ISearchTextCacheEntry {
	readonly revision: number;
	readonly text: string;
	readonly bytes: number;
}

export class ParadisSessionSearchTextCache {
	private readonly entries = new Map<string, ISearchTextCacheEntry>();
	private _bytes = 0;

	constructor(private readonly maxBytes: number) { }

	get size(): number {
		return this.entries.size;
	}

	get bytes(): number {
		return this._bytes;
	}

	get(catalogId: string, revision: number): string | undefined {
		const entry = this.entries.get(catalogId);
		if (!entry || entry.revision !== revision) {
			return undefined;
		}
		this.entries.delete(catalogId);
		this.entries.set(catalogId, entry);
		return entry.text;
	}

	set(catalogId: string, revision: number, text: string): void {
		this.delete(catalogId);
		const bytes = text.length * 2;
		if (bytes > this.maxBytes) {
			return;
		}
		this.entries.set(catalogId, { revision, text, bytes });
		this._bytes += bytes;
		while (this._bytes > this.maxBytes) {
			const oldestCatalogId = this.entries.keys().next().value;
			if (oldestCatalogId === undefined) {
				break;
			}
			this.delete(oldestCatalogId);
		}
	}

	delete(catalogId: string): void {
		const entry = this.entries.get(catalogId);
		if (!entry) {
			return;
		}
		this.entries.delete(catalogId);
		this._bytes -= entry.bytes;
	}
}
