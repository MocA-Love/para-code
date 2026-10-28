/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { BrowserEditor } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { ParadisBrowserLoadStallFeature } from './paradisBrowserLoadStallFeature.js';

BrowserEditor.registerContribution(ParadisBrowserLoadStallFeature);
