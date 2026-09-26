// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { workspaceUnavailableReason, type WorkspaceAvailabilityInput } from './workspaceAvailability.js';

function input(overrides: Partial<WorkspaceAvailabilityInput> = {}): WorkspaceAvailabilityInput {
	return {
		hasWorkspace: true,
		connection: 'online',
		pcOnline: true,
		sessionProtocolReady: true,
		manualOffline: false,
		rendererReady: true,
		...overrides,
	};
}

describe('workspaceUnavailableReason', () => {
	test('すべて揃っていれば理由は無い', () => {
		expect(workspaceUnavailableReason(input())).toBeUndefined();
	});

	test('理由ごとに別の文を返す', () => {
		const reasons = [
			workspaceUnavailableReason(input({ hasWorkspace: false })),
			workspaceUnavailableReason(input({ connection: 'offline', manualOffline: true })),
			workspaceUnavailableReason(input({ pcOnline: false })),
			workspaceUnavailableReason(input({ connection: 'connecting' })),
			workspaceUnavailableReason(input({ sessionProtocolReady: false })),
			workspaceUnavailableReason(input({ rendererReady: false })),
		];
		expect(reasons.every(reason => reason !== undefined)).toBe(true);
		expect(new Set(reasons).size).toBe(reasons.length);
	});

	test('ハンドシェイク中でも PC 不在が分かっていればオフラインとして伝える', () => {
		expect(workspaceUnavailableReason(input({ connection: 'handshaking', pcOnline: false })))
			.toBe(workspaceUnavailableReason(input({ pcOnline: false })));
	});

	test('手動で切断しているときは、PC 不在より切断を優先して伝える', () => {
		expect(workspaceUnavailableReason(input({ connection: 'offline', pcOnline: false, manualOffline: true })))
			.toBe(workspaceUnavailableReason(input({ connection: 'offline', manualOffline: true })));
	});

	test('接続済みなら手動切断の記録が残っていても画面の準備だけを見る', () => {
		expect(workspaceUnavailableReason(input({ manualOffline: true }))).toBeUndefined();
	});
});
