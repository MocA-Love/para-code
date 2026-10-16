/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process で、para-browser MCP へブックマークの道具を足す。`paradis.sharedProcess.contribution.ts` から副作用 import される。

import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { paradisRegisterMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { ParadisBookmarkToolProvider } from './paradisBookmarkToolProvider.js';

ParadisSharedProcessContributions.register('browserBookmarkTools', () => paradisRegisterMcpToolProvider(new ParadisBookmarkToolProvider()));
