/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
// PARA-PATCH: swapped in to scope the repository list to the current space (see paradisScopedScmViewService.ts)
import { ParadisScopedScmViewService } from '../../../../paradis/contrib/workspaceSwitch/browser/paradisScopedScmViewService.js';
import { ISCMService, ISCMViewService } from '../common/scm.js';
import { SCMService } from '../common/scmService.js';

registerSingleton(ISCMService, SCMService, InstantiationType.Delayed);
// PARA-PATCH: fork implementation that wraps the upstream one, swapped in at this single line
registerSingleton(ISCMViewService, ParadisScopedScmViewService, InstantiationType.Delayed);
