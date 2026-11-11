/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as eslint from 'eslint';
import type * as ESTree from 'estree';

/**
 * Para Code (Q617): inside src/vs/paradis, confirmations go through the fork's `IParadisDialogService.confirm`
 * (src/vs/paradis/contrib/confirmDialog/browser/paradisDialogService.ts), which shows the UI kit's confirmation.
 * Upstream's `IDialogService.confirm` shows the native macOS sheet with the default `window.dialogStyle`.
 *
 * The rule has no type information, so it goes by the receiver: `dialogService.confirm(...)`,
 * `this.dialogService.confirm(...)`, `this._dialogService.confirm(...)`, `services.dialogService.confirm(...)` and
 * `accessor.get(IDialogService).confirm(...)`. Other `confirm` methods (`this.confirm`, `closeHandler.confirm`, the
 * fork's `paradisDialogService.confirm`) are not reported.
 */
export default new class ParadisNoUpstreamConfirm implements eslint.Rule.RuleModule {

	readonly meta: eslint.Rule.RuleMetaData = {
		messages: {
			upstreamConfirm: 'Use IParadisDialogService.confirm (vs/paradis/contrib/confirmDialog/browser/paradisDialogService.ts) instead of IDialogService.confirm, which shows the native macOS sheet.',
		},
		schema: false,
	};

	create(context: eslint.Rule.RuleContext): eslint.Rule.RuleListener {

		function isUpstreamDialogService(node: ESTree.Node): boolean {
			if (node.type === 'Identifier') {
				return /^_?dialogService$/.test(node.name);
			}
			if (node.type === 'MemberExpression') {
				return !node.computed && node.property.type === 'Identifier' && /^_?dialogService$/.test(node.property.name);
			}
			if (node.type === 'CallExpression') {
				// accessor.get(IDialogService)
				return node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier' && node.callee.property.name === 'get'
					&& node.arguments.length === 1 && node.arguments[0].type === 'Identifier' && node.arguments[0].name === 'IDialogService';
			}
			return false;
		}

		return {
			['CallExpression > MemberExpression.callee[property.name="confirm"]']: (node: ESTree.MemberExpression) => {
				if (isUpstreamDialogService(node.object)) {
					context.report({ node, messageId: 'upstreamConfirm' });
				}
			},
		};
	}
};
