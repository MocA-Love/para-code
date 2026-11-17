/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// The fork's setup for a browser view session. browserSession.ts calls this one function from
// configure() so that the upstream file carries a single import and a single call.

import { IConfigurationService } from '../../configuration/common/configuration.js';
// Same import order as these had in browserSession.ts (module evaluation order stays as it was).
import { paradisInstallBrowserExtensions } from '../../../paradis/contrib/browserExtensions/electron-main/paradisBrowserExtensions.js';
import type { IParadisExtensionSessionOwner } from '../../../paradis/contrib/browserExtensions/electron-main/paradisBrowserExtensionsMain.js';
import { paradisApplyChromeLikeUserAgent } from '../../../paradis/contrib/browserUserAgent/electron-main/paradisBrowserUserAgent.js';
import { paradisConfigureBrowserDownloads } from '../../../paradis/contrib/browserDownloads/electron-main/paradisBrowserDownloads.js';

/**
 * Applies the fork's session setup, in this order: bundled React DevTools and user-installed
 * extensions (experimental), the Chrome-like user agent (strips the Electron and, by default, the
 * ParaCode tokens), and auto-saved downloads (a fixed folder instead of a native save dialog).
 */
export function paradisConfigureBrowserSession(session: Electron.Session, configurationService: IConfigurationService, owner: IParadisExtensionSessionOwner): void {
	paradisInstallBrowserExtensions(session, owner);
	paradisApplyChromeLikeUserAgent(session, configurationService);
	paradisConfigureBrowserDownloads(session, configurationService);
}
