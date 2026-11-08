/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 同梱した scrcpy-server（`media/scrcpy/`）の場所（`out/` からの相対）。取り込みは build/paradis/simulator/vendorScrcpy.ts。

import { PARADIS_SCRCPY_VERSION } from '../../common/paradisScrcpy.js';

export const PARADIS_SCRCPY_DIR = 'vs/paradis/contrib/simulator/node/media/scrcpy';
export const PARADIS_SCRCPY_SERVER_JAR = `${PARADIS_SCRCPY_DIR}/scrcpy-server-v${PARADIS_SCRCPY_VERSION}.jar`;
