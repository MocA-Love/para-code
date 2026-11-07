/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { promises as fsp } from 'fs';
import { dirname, join } from '../../base/common/path.js';

/**
 * ssh config の `Include` の 1 つのパス（`~` と相対パスは解いた後）を、読むファイルの一覧にする。
 * 名前に `*`・`?` があれば、そのフォルダーの合う名前を名前順に並べる（`Include ~/.ssh/conf.d/*.conf` など）。
 * 無ければそのまま 1 件。フォルダーを読めなければ空。
 */
export async function paradisSshIncludeFiles(resolved: string): Promise<string[]> {
	if (!/[*?]/.test(resolved)) {
		return [resolved];
	}
	const directory = dirname(resolved);
	const base = resolved.slice(directory.length + 1);
	const regex = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
	const files = await fsp.readdir(directory).catch(() => [] as string[]);
	return files.filter(name => regex.test(name)).sort().map(name => join(directory, name));
}
