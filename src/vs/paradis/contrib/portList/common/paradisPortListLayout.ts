/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const PARADIS_PORT_LIST_PANEL_MAX_WIDTH = 440;
const PARADIS_PORT_LIST_PANEL_MARGIN = 8;

export function paradisPortListPanelGeometry(viewportWidth: number, anchorRight: number): { readonly width: number; readonly left: number } {
	const available = Math.max(0, viewportWidth - PARADIS_PORT_LIST_PANEL_MARGIN * 2);
	const width = Math.min(PARADIS_PORT_LIST_PANEL_MAX_WIDTH, available);
	const maximumLeft = Math.max(PARADIS_PORT_LIST_PANEL_MARGIN, viewportWidth - width - PARADIS_PORT_LIST_PANEL_MARGIN);
	const left = Math.max(PARADIS_PORT_LIST_PANEL_MARGIN, Math.min(anchorRight - width, maximumLeft));
	return { width, left };
}
