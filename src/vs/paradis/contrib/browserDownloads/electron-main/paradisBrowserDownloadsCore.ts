/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as fs from 'fs';
import type { Session } from 'electron';
import { basename, extname, isAbsolute, join } from '../../../../base/common/path.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { PARADIS_BROWSER_DOWNLOADS_DEFAULT_SUBFOLDER, PARADIS_BROWSER_DOWNLOADS_ENABLED_KEY, PARADIS_BROWSER_DOWNLOADS_PATH_KEY } from '../common/paradisBrowserDownloads.js';

/**
 * `will-download` を配線済みのElectronセッション。同一セッションへの二重配線
 * （リスナー累積による `setSavePath` の多重呼び出し）を防ぐためのガード。
 */
const configuredSessions = new WeakSet<Session>();

/**
 * Electron main専用値の取得を呼び出し側へ分離した、ダウンロード配線のテスト可能な本体。
 */
export function paradisConfigureBrowserDownloadsWithPath(
	session: Session,
	configurationService: IConfigurationService,
	defaultDownloadsPath: () => string,
): void {
	if (configuredSessions.has(session)) {
		return;
	}
	configuredSessions.add(session);

	session.on('will-download', (_event, item) => {
		if (configurationService.getValue<boolean>(PARADIS_BROWSER_DOWNLOADS_ENABLED_KEY) === false) {
			return;
		}

		const customPath = configurationService.getValue<string>(PARADIS_BROWSER_DOWNLOADS_PATH_KEY)?.trim();
		const targetDirectory = customPath && isAbsolute(customPath)
			? customPath
			: join(defaultDownloadsPath(), PARADIS_BROWSER_DOWNLOADS_DEFAULT_SUBFOLDER);

		try {
			fs.mkdirSync(targetDirectory, { recursive: true });
		} catch (error) {
			console.error('[paradis] Failed to create the browser downloads directory, falling back to the save dialog:', error);
			return;
		}

		item.setSavePath(paradisResolveUniqueDownloadPath(targetDirectory, basename(item.getFilename())));
	});
}

function paradisResolveUniqueDownloadPath(directory: string, filename: string): string {
	const ext = extname(filename);
	const base = filename.slice(0, filename.length - ext.length);

	let candidate = join(directory, filename);
	for (let i = 1; fs.existsSync(candidate); i++) {
		candidate = join(directory, `${base} (${i})${ext}`);
	}
	return candidate;
}
