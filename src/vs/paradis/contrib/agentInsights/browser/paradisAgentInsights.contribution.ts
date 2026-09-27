/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IParadisAgentInsightsService } from '../common/paradisAgentInsights.js';
import { ParadisAgentInsightsStore } from './paradisAgentInsightsStore.js';

registerSingleton(IParadisAgentInsightsService, ParadisAgentInsightsStore, InstantiationType.Delayed);
