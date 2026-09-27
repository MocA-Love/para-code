/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentStatus, IParadisPaneBinding } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisPaneDescriptor } from '../../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import { paradisDesignTargetEntries } from '../../electron-browser/paradisDesignModeSender.js';

function pane(instanceId: number, overrides: Partial<IParadisPaneDescriptor> = {}): IParadisPaneDescriptor {
	return {
		instanceId,
		token: `token-${instanceId}`,
		title: `pane-${instanceId}`,
		agentKind: 'claude',
		mcpConnected: false,
		binding: undefined,
		bindEligibility: { eligible: true },
		...overrides,
	};
}

suite('paradisDesignTargetEntries', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('同じスペースのエージェントだけを、共有中・入れられる順に並べる', () => {
		const statuses = new Map<number, ParadisAgentStatus>([[2, 'permission'], [3, 'working']]);
		const entries = paradisDesignTargetEntries([
			pane(1, { agentKind: 'shell' }),
			pane(2),
			pane(3, { agentKind: 'codex' }),
			pane(4, { binding: upcastPartial<IParadisPaneBinding>({ pageId: 'page-1' }) }),
			pane(5, { bindEligibility: { eligible: false, reason: 'differentScope' } }),
			pane(6, { agentKind: 'shell' }),
		], 'page-1', instanceId => instanceId === 6, instanceId => statuses.get(instanceId));
		assert.deepStrictEqual(entries.map(entry => [entry.instanceId, entry.agentKind, entry.sharedWithPage, entry.available]), [
			[4, 'claude', true, true],
			[3, 'codex', false, true],
			[6, 'agent', false, true],
			[2, 'claude', false, false],
		]);
	});
});
