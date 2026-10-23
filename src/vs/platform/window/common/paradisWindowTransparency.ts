/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { isWindows } from '../../../base/common/platform.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { hasNativeTitlebar } from './window.js';

/**
 * この環境でウィンドウの透過を使えるか。Electron の透過ウィンドウは、Windows では枠なしでしか作れないため、
 * Windows でタイトルバーを native にしていると使えない。
 * main プロセスがウィンドウを作るとき (windowImpl.ts) と、renderer が再起動を促すかを決めるときの両方で使う。
 */
export function paradisCanUseWindowTransparency(configurationService: IConfigurationService, windows: boolean = isWindows): boolean {
	return !windows || !hasNativeTitlebar(configurationService);
}
