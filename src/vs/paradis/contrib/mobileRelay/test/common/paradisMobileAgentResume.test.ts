/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisResumeSession } from '../../../sessionResume/common/paradisSessionResume.js';
import { PARADIS_AGENT_APPROVAL_OPTIONS_CAPABILITY } from '../../common/paradisAgentApprovalOptions.js';
import { ParadisMobileCapability, PARADIS_MOBILE_PC_CAPABILITIES } from '../../common/paradisMobileCompat.js';
import { PARADIS_AGENT_RESUME_CAPABILITY, PARADIS_AGENT_SESSION_KEY_PATTERN, paradisAgentSessionKey, paradisMobileAgentSessionMatches, paradisMobileAgentSessionView, paradisRecordResumeRequest } from '../../common/paradisMobileAgentResume.js';

suite('paradisMobileAgentResume (W2-29)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const session: IParadisResumeSession = {
		catalogId: 'catalog-1', id: '0f7c1d2e-session', agent: 'claude', title: 'ログイン画面の\n修正', preview: '最初の依頼',
		latestMessage: { role: 'assistant', text: '直しました。テストも通っています' },
		cwd: '/Users/example/projects/demo', spaceStateKey: 'repo-1', spaceName: 'demo', currentSpace: false,
		createdAt: 1_760_000_000_000, updatedAt: 1_760_000_100_000, archived: false, gitBranch: 'fix/login',
	};

	test('advertises the capabilities of lane L3 under the names the feature files use', () => {
		assert.deepStrictEqual({
			approval: PARADIS_AGENT_APPROVAL_OPTIONS_CAPABILITY === ParadisMobileCapability.AgentApprovalOptions,
			resume: PARADIS_AGENT_RESUME_CAPABILITY === ParadisMobileCapability.AgentResume,
			advertised: [ParadisMobileCapability.AgentApprovalOptions, ParadisMobileCapability.AgentHistoryPage, ParadisMobileCapability.AgentResume].every(name => PARADIS_MOBILE_PC_CAPABILITIES.includes(name)),
		}, { approval: true, resume: true, advertised: true });
	});

	test('makes a stable fingerprint per agent and session that the phone cannot turn back into the id', () => {
		const key = paradisAgentSessionKey('claude', '0f7c1d2e-session');
		assert.deepStrictEqual({
			stable: key === paradisAgentSessionKey('claude', '0f7c1d2e-session'),
			shape: PARADIS_AGENT_SESSION_KEY_PATTERN.test(key),
			perAgent: key !== paradisAgentSessionKey('codex', '0f7c1d2e-session'),
			containsId: key.includes('0f7c1d2e'),
		}, { stable: true, shape: true, perAgent: true, containsId: false });
	});

	test('sends only what the list needs to the phone (no session id, path or catalog id)', () => {
		const view = paradisMobileAgentSessionView(session, 'terminal-key-1');
		assert.deepStrictEqual(view, {
			key: paradisAgentSessionKey('claude', '0f7c1d2e-session'),
			agent: 'claude',
			title: 'ログイン画面の 修正',
			preview: '直しました。テストも通っています',
			previewRole: 'assistant',
			updatedAt: 1_760_000_100_000,
			createdAt: 1_760_000_000_000,
			branch: 'fix/login',
			terminalKey: 'terminal-key-1',
		});
		assert.strictEqual(JSON.stringify(view).includes('/Users/example'), false);
	});

	test('filters by every word in the title, the last message or the branch', () => {
		const view = paradisMobileAgentSessionView(session, undefined);
		assert.deepStrictEqual({
			none: paradisMobileAgentSessionMatches(view, undefined),
			title: paradisMobileAgentSessionMatches(view, 'ログイン'),
			both: paradisMobileAgentSessionMatches(view, 'ログイン テスト'),
			branch: paradisMobileAgentSessionMatches(view, 'FIX/LOGIN'),
			miss: paradisMobileAgentSessionMatches(view, 'ログイン 決済'),
		}, { none: true, title: true, both: true, branch: true, miss: false });
	});

	test('keeps the resume ledger to the latest 500 requests within three days and replaces the same id', () => {
		const now = 10 * 24 * 60 * 60 * 1000;
		let ledger = Array.from({ length: 500 }, (_, index) => ({ id: `r${index}`, at: now - 1000 + index, status: 'resumed' as const }));
		ledger = [{ id: 'old', at: now - 4 * 24 * 60 * 60 * 1000, status: 'resumed' as const }, ...ledger];
		const next = paradisRecordResumeRequest(ledger, { id: 'r499', at: now, status: 'failed' }, now);
		const added = paradisRecordResumeRequest(next, { id: 'new', at: now, status: 'started' }, now);
		assert.deepStrictEqual({
			length: added.length,
			hasOld: added.some(entry => entry.id === 'old'),
			first: added[0]?.id,
			replaced: added.filter(entry => entry.id === 'r499').map(entry => entry.status),
			last: added.at(-1)?.id,
		}, { length: 500, hasOld: false, first: 'r1', replaced: ['failed'], last: 'new' });
	});
});
