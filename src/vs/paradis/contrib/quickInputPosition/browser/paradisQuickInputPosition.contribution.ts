/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// コマンドパレットなどの quick input を、画面の上から 25% (upstream の「中央」) に一度だけ移し (paradisQuickInputPosition.ts)、
// 開いているあいだ作業領域を暗くする (paradisQuickInputScrim.ts)。Q593。
// タイトルバーのコマンドセンターを既定で消すのは paradisDefaultSettings.contribution.ts。

import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ParadisQuickInputLook } from './paradisQuickInputLook.js';
import { ParadisQuickInputPosition } from './paradisQuickInputPosition.js';
import { ParadisQuickInputScrim } from './paradisQuickInputScrim.js';

registerWorkbenchContribution2(ParadisQuickInputPosition.ID, ParadisQuickInputPosition, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ParadisQuickInputScrim.ID, ParadisQuickInputScrim, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ParadisQuickInputLook.ID, ParadisQuickInputLook, WorkbenchPhase.AfterRestored);
