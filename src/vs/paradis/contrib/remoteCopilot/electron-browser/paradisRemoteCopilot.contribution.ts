/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の窓で本家の Copilot のエージェントホストを既定で起動しない設定と、その差し替えの登録。
//
// registerSingleton は後から登録したものが使われる（workbench.ts が登録順に serviceCollection.set する）。
// このファイルは workbench.desktop.main.ts の末尾近くの paradis.electron-browser.contribution.ts から
// 読み込まれ、upstream の登録（platform/agentHost/browser/agentHostEnablementService.ts）より後になる。
// デスクトップ専用の登録なので、Web の WebAgentHostEnablementService には触れない。

import { IAgentHostEnablementService } from '../../../../platform/agentHost/common/agentHostEnablementService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ParadisAgentHostEnablementService } from '../browser/paradisRemoteCopilotEnablement.js';

registerSingleton(IAgentHostEnablementService, ParadisAgentHostEnablementService, InstantiationType.Eager);
