/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentLogoForId } from '../../../../common/paradisAgentLogoPaths.js';
import { paradisAgentLabel } from '../../../mobileRelay/common/paradisNotifyPresentation.js';
import { paradisAgentResumeCommandLine, paradisResumeAgentLabel, paradisResumeCanBypassPermissions, paradisResumeCanFork } from '../../../sessionResume/common/paradisSessionResume.js';
import { ParadisHandoffAgentKind, paradisHandoffAgentLabel } from '../../../terminalEditorMenu/common/paradisAgentSessionHandoff.js';
import { paradisAgentChatActionSupport } from '../../common/paradisAgentChatActionSupport.js';
import { PARADIS_AGENT_DESCRIPTORS, PARADIS_AGENT_KINDS, ParadisAgentKind, paradisAgentDescriptor } from '../../common/paradisAgentDescriptor.js';

suite('paradisAgentDescriptor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('describes each agent kind with the values the product uses today', () => {
		assert.deepStrictEqual(PARADIS_AGENT_DESCRIPTORS, {
			claude: {
				displayName: 'Claude Code', shortName: 'Claude', logo: 'claude',
				resume: { fork: true, bypassFlag: '--dangerously-skip-permissions', deliverPromptAfterResume: true, sendQueuedWithoutConfirm: true },
				modelControl: 'mod-or-keys',
				send: ['mod', 'keys'], queuesWhileWorking: true, answerQuestion: ['mod', 'keys'], answerApproval: ['mod', 'keys'],
				interrupt: 'ctrl-c', commandCatalog: 'mod-or-files',
				features: { subagents: true, teams: true, workflows: true, shells: true, panel: true, pcDraft: true, sessionStatus: true, asyncQuestions: false },
			},
			codex: {
				displayName: 'Codex', shortName: 'Codex', logo: 'codex',
				resume: { fork: true, bypassFlag: '--dangerously-bypass-approvals-and-sandbox', deliverPromptAfterResume: true, sendQueuedWithoutConfirm: true },
				modelControl: 'none',
				send: ['keys'], queuesWhileWorking: false, answerQuestion: ['keys'], answerApproval: ['keys'],
				interrupt: 'ctrl-c', commandCatalog: 'files',
				features: { subagents: true, teams: false, workflows: false, shells: false, panel: false, pcDraft: false, sessionStatus: true, asyncQuestions: true },
			},
			opencode: {
				displayName: 'OpenCode', shortName: 'OpenCode', logo: undefined,
				resume: { fork: true, bypassFlag: undefined, deliverPromptAfterResume: true, sendQueuedWithoutConfirm: true },
				modelControl: 'none',
				send: ['api'], queuesWhileWorking: false, answerQuestion: ['api'], answerApproval: ['api'],
				interrupt: 'api', commandCatalog: 'api',
				features: { subagents: false, teams: false, workflows: false, shells: false, panel: false, pcDraft: false, sessionStatus: true, asyncQuestions: false },
			},
			antigravity: {
				displayName: 'Antigravity CLI', shortName: 'Antigravity', logo: 'antigravity',
				resume: { fork: false, bypassFlag: undefined, deliverPromptAfterResume: false, sendQueuedWithoutConfirm: false },
				modelControl: 'none',
				send: ['keys'], queuesWhileWorking: false, answerQuestion: [], answerApproval: ['hook'],
				interrupt: 'ctrl-c', commandCatalog: 'none',
				features: { subagents: false, teams: false, workflows: false, shells: false, panel: false, pcDraft: false, sessionStatus: false, asyncQuestions: false },
			},
		});
	});

	test('keeps the action table, the names and the resume rules that existed before the descriptor', () => {
		// 型に無い値（古い保存データ・電文）の落ち先
		const kinds: readonly (ParadisAgentKind | undefined)[] = [...PARADIS_AGENT_KINDS, 'other' as ParadisAgentKind, undefined];
		assert.deepStrictEqual(kinds.map(kind => ({
			kind,
			support: kind === 'other' as ParadisAgentKind ? undefined : paradisAgentChatActionSupport(kind),
			resumeLabel: kind !== undefined ? paradisResumeAgentLabel(kind) : undefined,
			notifyLabel: kind !== undefined ? paradisAgentLabel(kind) : undefined,
			handoffLabel: paradisHandoffAgentLabel(kind as ParadisHandoffAgentKind | undefined),
			described: paradisAgentDescriptor(kind) !== undefined,
		})), [
			{ kind: 'claude', support: { sendMessage: true, answerQuestion: true, answerApproval: true, settings: true }, resumeLabel: 'Claude Code', notifyLabel: 'Claude', handoffLabel: 'Claude Code', described: true },
			{ kind: 'codex', support: { sendMessage: true, answerQuestion: true, answerApproval: true, settings: false }, resumeLabel: 'Codex', notifyLabel: 'Codex', handoffLabel: 'Codex', described: true },
			{ kind: 'opencode', support: { sendMessage: true, answerQuestion: true, answerApproval: true, settings: false }, resumeLabel: 'OpenCode', notifyLabel: 'OpenCode', handoffLabel: 'OpenCode', described: true },
			{ kind: 'antigravity', support: { sendMessage: true, answerQuestion: false, answerApproval: false, settings: false }, resumeLabel: 'Antigravity CLI', notifyLabel: 'Antigravity', handoffLabel: undefined, described: true },
			{ kind: 'other', support: undefined, resumeLabel: 'OpenCode', notifyLabel: 'Claude', handoffLabel: undefined, described: false },
			{ kind: undefined, support: { sendMessage: true, answerQuestion: true, answerApproval: true, settings: true }, resumeLabel: undefined, notifyLabel: undefined, handoffLabel: undefined, described: false },
		]);
	});

	test('agrees with the logo table and the resume command builder', () => {
		const id = '01234567-89ab-cdef-0123-456789abcdef';
		assert.deepStrictEqual(PARADIS_AGENT_KINDS.map(kind => {
			const descriptor = PARADIS_AGENT_DESCRIPTORS[kind];
			return {
				kind,
				logo: descriptor.logo,
				fork: descriptor.resume.fork,
				canBypass: descriptor.resume.bypassFlag !== undefined,
				bypassFlagInCommand: descriptor.resume.bypassFlag === undefined ? undefined
					: paradisAgentResumeCommandLine(kind, id, 'resume', { dangerouslyBypassPermissions: true })?.includes(` ${descriptor.resume.bypassFlag} `),
			};
		}), PARADIS_AGENT_KINDS.map(kind => ({
			kind,
			logo: paradisAgentLogoForId(kind),
			fork: paradisResumeCanFork(kind),
			canBypass: paradisResumeCanBypassPermissions(kind),
			bypassFlagInCommand: paradisResumeCanBypassPermissions(kind) ? true : undefined,
		})));
	});
});
