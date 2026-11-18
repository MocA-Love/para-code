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
import { paradisDesignDefaultTarget, paradisDesignTargetEntries } from '../../electron-browser/paradisDesignModeSender.js';

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

	test('2 枚目以降の共有（そのペインの current ではないページ）も共有中として拾う', () => {
		const other = upcastPartial<IParadisPaneBinding>({ pageId: 'page-other' });
		const entries = paradisDesignTargetEntries([pane(1, { binding: other }), pane(2)], 'page-1', () => true, () => undefined, new Set(['token-1']));
		assert.deepStrictEqual(entries.map(entry => [entry.instanceId, entry.sharedWithPage]), [[1, true], [2, false]]);
	});
});

suite('paradisDesignDefaultTarget', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('前回選んだ送り先 → 共有先がちょうど 1 つ の順に決め、回答待ちでも既定は変えない', () => {
		const target = (panes: IParadisPaneDescriptor[], sharedTokens: string[], lastTarget?: number, statuses = new Map<number, ParadisAgentStatus>()) => {
			const entry = paradisDesignDefaultTarget(
				paradisDesignTargetEntries(panes, 'page-1', () => true, instanceId => statuses.get(instanceId), new Set(sharedTokens)),
				lastTarget,
			);
			return entry ? [entry.instanceId, entry.available] : undefined;
		};
		assert.deepStrictEqual({
			none: target([pane(1), pane(2)], []),
			single: target([pane(1), pane(2)], ['token-2']),
			two: target([pane(1), pane(2)], ['token-1', 'token-2']),
			twoRemembered: target([pane(1), pane(2)], ['token-1', 'token-2'], 2),
			rememberedOverShared: target([pane(1), pane(2)], ['token-2'], 1),
			rememberedNotShared: target([pane(1), pane(2)], [], 1),
			rememberedGone: target([pane(1), pane(2)], ['token-2'], 9),
			rememberedOtherScope: target([pane(1, { bindEligibility: { eligible: false, reason: 'differentScope' } }), pane(2)], [], 1),
			waiting: target([pane(1), pane(2)], ['token-2'], undefined, new Map<number, ParadisAgentStatus>([[2, 'permission']])),
		}, {
			none: undefined,
			single: [2, true],
			two: undefined,
			twoRemembered: [2, true],
			rememberedOverShared: [1, true],
			rememberedNotShared: [1, true],
			rememberedGone: [2, true],
			rememberedOtherScope: undefined,
			waiting: [2, false],
		});
	});
});
