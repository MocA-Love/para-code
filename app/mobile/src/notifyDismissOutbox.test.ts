// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import {
	EMPTY_NOTIFY_DISMISS_OUTBOX, NOTIFY_DISMISS_OUTBOX_LIMIT, NOTIFY_DISMISS_OUTBOX_MAX_AGE_MS,
	addNotifyDismissOutbox, parseNotifyDismissOutbox, removeNotifyDismissOutbox, serializeNotifyDismissOutbox,
} from './notifyDismissOutbox.js';

const T0 = 1_800_000_000_000;

describe('notifyDismissOutbox', () => {
	it('round-trips, replaces the same id, removes acknowledged ids and drops malformed or expired entries', () => {
		let state = addNotifyDismissOutbox(EMPTY_NOTIFY_DISMISS_OUTBOX, { id: 'a', opened: true, at: T0 });
		state = addNotifyDismissOutbox(state, { id: 'b', opened: false, at: T0 + 1 });
		state = addNotifyDismissOutbox(state, { id: 'a', opened: true, at: T0 + 2 });
		state = { ...state, cursor: { ledger: 'ledger-0001', seq: 3 } };
		const raw = serializeNotifyDismissOutbox(state);
		const withJunk = JSON.stringify({ ...JSON.parse(raw), entries: [...JSON.parse(raw).entries, { id: 5, at: T0 }, { id: 'old', opened: true, at: T0 - NOTIFY_DISMISS_OUTBOX_MAX_AGE_MS - 1 }] });
		expect({
			ids: state.entries.map(entry => entry.id),
			parsed: parseNotifyDismissOutbox(withJunk, T0 + 3),
			removed: removeNotifyDismissOutbox(state, ['a']).entries.map(entry => entry.id),
			unchanged: removeNotifyDismissOutbox(state, []) === state,
			broken: [parseNotifyDismissOutbox('{', T0), parseNotifyDismissOutbox(null, T0), parseNotifyDismissOutbox('{"v":2}', T0)],
		}).toEqual({
			ids: ['b', 'a'],
			parsed: { cursor: { ledger: 'ledger-0001', seq: 3 }, entries: [{ id: 'b', opened: false, at: T0 + 1 }, { id: 'a', opened: true, at: T0 + 2 }] },
			removed: ['b'],
			unchanged: true,
			broken: [EMPTY_NOTIFY_DISMISS_OUTBOX, EMPTY_NOTIFY_DISMISS_OUTBOX, EMPTY_NOTIFY_DISMISS_OUTBOX],
		});
	});

	it('keeps at most the newest entries up to the limit', () => {
		let state = EMPTY_NOTIFY_DISMISS_OUTBOX;
		for (let index = 0; index < NOTIFY_DISMISS_OUTBOX_LIMIT + 5; index++) {
			state = addNotifyDismissOutbox(state, { id: `n${index}`, opened: true, at: T0 + index });
		}
		expect([state.entries.length, state.entries[0]!.id]).toEqual([NOTIFY_DISMISS_OUTBOX_LIMIT, 'n5']);
	});
});
