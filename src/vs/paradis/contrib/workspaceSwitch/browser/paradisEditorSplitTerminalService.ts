/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisEditorSplitTerminalService } from '../../../../workbench/services/editor/common/paradisEditorSplitTerminalService.js';

export { IParadisEditorSplitTerminalService } from '../../../../workbench/services/editor/common/paradisEditorSplitTerminalService.js';

export const PARADIS_OPEN_TERMINAL_ON_SPLIT_SETTING = 'paradis.editor.openTerminalOnSplit';

export class ParadisEditorSplitTerminalService extends Disposable implements IParadisEditorSplitTerminalService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
	}

	async openTerminalInGroup(group: IEditorGroup): Promise<void> {
		if (!this.configurationService.getValue<boolean>(PARADIS_OPEN_TERMINAL_ON_SPLIT_SETTING)) {
			return;
		}

		let instance: ITerminalInstance | undefined;
		let groupDisposed = false;
		const groupDisposal = group.onWillDispose(() => {
			groupDisposed = true;
			if (instance && !instance.isDisposed) {
				instance.dispose();
			}
		});

		try {
			this.assertGroupIsExact(group, groupDisposed);
			instance = await this.terminalService.createTerminal({
				location: { viewColumn: group.id },
				paradisExactEditorGroup: group,
				// Extension-contributed profile creation crosses IPC using only a numeric view column,
				// so the split-only exact object identity cannot be preserved on that path. Use the
				// resolved built-in default shell instead of rejecting the user's split operation.
				skipContributedProfileCheck: true,
			});
			this.assertGroupIsExact(group, groupDisposed);
			await this.terminalService.focusInstance(instance);
			this.assertGroupIsExact(group, groupDisposed);
		} catch (error) {
			if (instance && !instance.isDisposed) {
				instance.dispose();
			}
			this.notificationService.error(localize(
				'paradis.editor.openTerminalOnSplitFailed',
				"Could not open a terminal in the new editor group: {0}",
				getErrorMessage(error),
			));
		} finally {
			groupDisposal.dispose();
		}
	}

	private assertGroupIsExact(group: IEditorGroup, groupDisposed: boolean): void {
		if (groupDisposed || this.editorGroupsService.getGroup(group.id) !== group) {
			throw new Error(localize(
				'paradis.editor.splitDestinationDisposed',
				"The destination editor group is no longer available.",
			));
		}
	}
}
