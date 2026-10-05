// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { AGENT_SEND_RETRY_WINDOW_MS, AgentSendIdBook, newAgentSendId } from './agentSendIds.js';

function book(): { readonly ids: AgentSendIdBook; advance(ms: number): void } {
	let now = 1_000_000;
	let counter = 0;
	return {
		ids: new AgentSendIdBook(() => now, () => `id-${++counter}`),
		advance: ms => { now += ms; },
	};
}

describe('agentSendIds', () => {
	it('makes ids the PC accepts', () => {
		expect(newAgentSendId()).toMatch(/^[A-Za-z0-9._:-]{1,100}$/);
	});

	it('reuses the id only when the same text is sent again after an unconfirmed failure', () => {
		const { ids, advance } = book();
		const first = ids.idFor('t1', '続けて');
		ids.settle('t1', '続けて', first, { status: 'rejected' }); // 30 秒の時間切れ（届いたか分からない）
		const retry = ids.idFor('t1', '続けて');
		const otherText = ids.idFor('t1', '別の文');
		const otherTerminal = ids.idFor('t2', '続けて');
		advance(AGENT_SEND_RETRY_WINDOW_MS + 1);
		const late = ids.idFor('t1', '続けて');
		expect({ retry, otherText, otherTerminal, late }).toEqual({ retry: first, otherText: 'id-2', otherTerminal: 'id-3', late: 'id-4' });
	});

	it('forgets the id after an accepted send, a reasoned rejection or text left in the terminal', () => {
		const outcomes = [{ status: 'accepted' as const }, { status: 'rejected' as const, code: 'stale-session' }, { status: 'consumed' as const }];
		const reused = outcomes.map(outcome => {
			const { ids } = book();
			const first = ids.idFor('t1', 'x');
			ids.settle('t1', 'x', first, { status: 'rejected' });
			ids.settle('t1', 'x', first, outcome);
			return ids.idFor('t1', 'x') === first;
		});
		expect(reused).toEqual([false, false, false]);
	});
});
