/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot の帯を「スペース」のビューへ登録する。Bot のサービスはデスクトップにしか無いので、electron-browser から登録する
// （paradis.electron-browser.contribution.ts から読み込む。Web のビューには帯が出ない）。

import { registerParadisWorkspacesBand } from '../../workspaceSwitch/browser/paradisWorkspacesBands.js';
import '../browser/paradisBotsSettings.contribution.js';
import { ParadisBotsBandSlot } from '../browser/paradisBotsBand.js';

registerParadisWorkspacesBand(ParadisBotsBandSlot);
