// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { homeAgentMenuItems } from './homeAgentActionsMenuItems.js';

describe('homeAgentMenuItems', () => {
	test('一覧の行はスワイプの3操作（確認済み・アーカイブ・削除）も含み、削除が最後', () => {
		expect(homeAgentMenuItems({ pinned: false, origin: 'list' }).map(item => item.action))
			.toEqual(['rename', 'pin', 'ack', 'archive', 'delete']);
	});

	test('要対応スタックの行には片付ける操作を出さない（アーカイブしても自動で戻るため）', () => {
		expect(homeAgentMenuItems({ pinned: false, origin: 'attention' }).map(item => item.action))
			.toEqual(['rename', 'pin', 'delete']);
	});

	test('ピン留めの項目は現在の状態の逆を示す', () => {
		expect(homeAgentMenuItems({ pinned: true, origin: 'list' }).find(item => item.action === 'pin')?.label).toBe('ピン留めを解除');
		expect(homeAgentMenuItems({ pinned: false, origin: 'list' }).find(item => item.action === 'pin')?.label).toBe('ピン留め');
	});

	test('削除だけが破壊的な操作として示される', () => {
		expect(homeAgentMenuItems({ pinned: false, origin: 'list' }).filter(item => item.destructive === true).map(item => item.action))
			.toEqual(['delete']);
	});
});
