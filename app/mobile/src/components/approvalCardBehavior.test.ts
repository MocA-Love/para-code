// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import type { AgentApprovalChoice } from '../store.js';
import { approvalButtonLayout, isLongApprovalDetail, orderApprovalChoices } from './approvalCardBehavior.js';

const allow: AgentApprovalChoice = { id: 'yes', label: '許可', tone: 'approve' };
const deny: AgentApprovalChoice = { id: 'no', label: '拒否', tone: 'deny' };
const always: AgentApprovalChoice = { id: 'always', label: '常に許可', tone: 'neutral' };

describe('orderApprovalChoices', () => {
	it('places deny first, other choices in the middle and allow last', () => {
		expect(orderApprovalChoices([allow, always, deny]).map(spec => [spec.choice.id, spec.variant])).toEqual([
			['no', 'destructive'],
			['always', 'secondary'],
			['yes', 'primary'],
		]);
	});

	it('keeps only one primary when several approve-toned choices exist', () => {
		const session: AgentApprovalChoice = { id: 'session', label: 'このセッション中は許可', tone: 'approve' };
		const specs = orderApprovalChoices([allow, session, deny]);
		expect(specs.filter(spec => spec.variant === 'primary').map(spec => spec.choice.id)).toEqual(['yes']);
		expect(specs.map(spec => spec.choice.id)).toEqual(['no', 'session', 'yes']);
	});

	it('works without an approve choice', () => {
		expect(orderApprovalChoices([deny, always]).map(spec => spec.variant)).toEqual(['destructive', 'secondary']);
	});
});

describe('approvalButtonLayout', () => {
	it('stays in a row for up to three short choices', () => {
		expect(approvalButtonLayout([deny, always, allow])).toBe('row');
	});

	it('stacks vertically when a label is long or there are many choices', () => {
		expect(approvalButtonLayout([deny, { id: 'x', label: '今後このコマンドは確認しない', tone: 'approve' }])).toBe('column');
		expect(approvalButtonLayout([deny, always, allow, { id: 'abort', label: '中止', tone: 'deny' }])).toBe('column');
	});
});

describe('isLongApprovalDetail', () => {
	it('treats short details as fitting in the card', () => {
		expect(isLongApprovalDetail(undefined)).toBe(false);
		expect(isLongApprovalDetail('rm -rf node_modules && pnpm install')).toBe(false);
	});

	it('detects many lines or long wrapped lines', () => {
		expect(isLongApprovalDetail(['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n'))).toBe(true);
		expect(isLongApprovalDetail('x'.repeat(48 * 6 + 1))).toBe(true);
	});
});
