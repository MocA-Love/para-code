/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { URI } from '../../../../../base/common/uri.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { MenuWorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';

const $ = DOM.$;

export interface IMobileChangesToolbarContext {
	readonly instantiationService: IInstantiationService;
	readonly sessionResource: URI;
}

export function appendMobileChangesToolbar(header: HTMLElement, context: IMobileChangesToolbarContext, store: DisposableStore): void {
	const toolbarContainer = DOM.append(header, $('div.mobile-changes-toolbar'));
	store.add(context.instantiationService.createInstance(
		MenuWorkbenchToolBar,
		toolbarContainer,
		MenuId.AgentsChangesToolbar,
		{
			telemetrySource: 'mobileChanges',
			menuOptions: { arg: context.sessionResource },
			toolbarOptions: { primaryGroup: () => false },
		},
	));
}
