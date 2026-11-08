// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { clearToastAnchor, setToastAnchor, toastPlacement, useToastAnchor } from './toastAnchor.js';

const PHONE = { width: 402, height: 874 };
const IPAD = { width: 1366, height: 1024 };

describe('toastPlacement', () => {
	it('sits just above the bottom band, centred in its column, and falls back to the fixed spot without one', () => {
		expect([
			toastPlacement(undefined, PHONE, 34),
			toastPlacement({ top: 600, left: 0, width: 402 }, PHONE, 34),
			// iPad の 2 列: 詳細の列（左の列 360 の右）の中に出す
			toastPlacement({ top: 820, left: 360, width: 1006 }, IPAD, 20),
			// 壊れた値は使わない
			toastPlacement({ top: Number.NaN, left: 0, width: 402 }, PHONE, 34),
			toastPlacement({ top: 900, left: 0, width: 402 }, PHONE, 34),
			toastPlacement({ top: 600, left: 0, width: 0 }, PHONE, 34),
		]).toEqual([
			{ bottom: 196 },
			{ bottom: 282, left: 0, width: 402 },
			{ bottom: 212, left: 360, width: 1006 },
			{ bottom: 196 },
			{ bottom: 196 },
			{ bottom: 196 },
		]);
	});
});

describe('toast anchor owners', () => {
	it('clears only the anchor its owner set', () => {
		const older = {};
		const newer = {};
		setToastAnchor(older, { top: 500, left: 0, width: 402 });
		setToastAnchor(newer, { top: 600, left: 0, width: 402 });
		clearToastAnchor(older);
		const kept = useToastAnchor.getState().rect;
		clearToastAnchor(newer);
		expect([kept, useToastAnchor.getState().rect]).toEqual([{ top: 600, left: 0, width: 402 }, undefined]);
	});
});
