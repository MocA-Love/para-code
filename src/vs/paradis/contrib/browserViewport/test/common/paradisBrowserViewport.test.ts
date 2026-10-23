/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisViewportSize,
	paradisDescribeViewport,
	paradisParseViewportDimensions,
	paradisParseViewportSizes,
	paradisResolveViewportDefault,
	paradisResolveViewportSpec,
	paradisSanitizeViewportName,
	paradisViewportDevice,
	paradisViewportSpecMatches,
} from '../../common/paradisBrowserViewport.js';
import { ParadisAgentEmulationLedger, paradisEmulatedScreenshotSize, paradisFoldDeviceMetricsOverride, paradisMergeEmulatedMedia, paradisScaleCdpInputCoordinates } from '../../common/paradisBrowserViewportCdp.js';
import { paradisFormatSetViewportResult, paradisViewportForAgent } from '../../common/paradisBrowserViewportTools.js';

const SIZES: readonly IParadisViewportSize[] = [
	{ name: '社内 PC', width: 1366, height: 768 },
	{ name: 'iPhone 15', width: 390, height: 844, mobile: true, deviceScaleFactor: 3, userAgent: 'iPhone UA' },
];

suite('paradisBrowserViewport', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads WIDTHxHEIGHT in the usual spellings and refuses sizes out of range', () => {
		assert.deepStrictEqual(
			['1366x768', '1366×768', ' 1366 * 768 ', '1366 768', '１３６６ｘ７６８', '99x768', '1366x10000', 'iPhone', ''].map(text => paradisParseViewportDimensions(text)),
			[
				{ width: 1366, height: 768 },
				{ width: 1366, height: 768 },
				{ width: 1366, height: 768 },
				{ width: 1366, height: 768 },
				{ width: 1366, height: 768 },
				undefined,
				undefined,
				undefined,
				undefined,
			],
		);
	});

	test('resolves a name before dimensions, "auto" and empty to fit, and refuses anything else', () => {
		assert.deepStrictEqual(
			['iphone 15', '  社内 PC ', '1280x720', 'auto', '', 'エディタに合わせる', 'Galaxy'].map(spec => paradisResolveViewportSpec(spec, SIZES)),
			[
				{ kind: 'size', size: SIZES[1] },
				{ kind: 'size', size: SIZES[0] },
				{ kind: 'size', size: { width: 1280, height: 720 } },
				{ kind: 'fit' },
				{ kind: 'fit' },
				{ kind: 'fit' },
				undefined,
			],
		);
	});

	test('a size replaces the whole device, so a phone UA and touch do not stay behind', () => {
		assert.deepStrictEqual([paradisViewportDevice(SIZES[1]), paradisViewportDevice(SIZES[0])], [
			{ width: 390, height: 844, mobile: true, deviceScaleFactor: 3, userAgent: 'iPhone UA' },
			{ width: 1366, height: 768 },
		]);
	});

	test('describes fit, named, custom and half-set devices from the device alone', () => {
		const pane = { width: 1240.4, height: 860 };
		assert.deepStrictEqual([
			paradisDescribeViewport(undefined, SIZES, pane),
			paradisDescribeViewport(undefined, SIZES, undefined),
			paradisDescribeViewport({ width: 1366, height: 768 }, SIZES, pane),
			paradisDescribeViewport({ width: 390, height: 844, mobile: true }, SIZES, pane),
			paradisDescribeViewport({ width: 390, height: 844 }, SIZES, pane),
			paradisDescribeViewport({ width: 800 }, SIZES, pane),
			paradisDescribeViewport({ userAgent: 'x' }, SIZES, pane),
		], [
			{ fit: true, width: 1240, height: 860, mobile: false },
			{ fit: true, mobile: false },
			{ fit: false, name: '社内 PC', width: 1366, height: 768, mobile: false },
			{ fit: false, name: 'iPhone 15', width: 390, height: 844, mobile: true },
			{ fit: false, width: 390, height: 844, mobile: false },
			{ fit: false, width: 800, height: 860, mobile: false },
			{ fit: true, width: 1240, height: 860, mobile: false },
		]);
	});

	test('the space default wins over its main tree, which wins over the global default', () => {
		const spaces = new Map([['repo', 'iPhone 15'], ['other', '']]);
		assert.deepStrictEqual([
			paradisResolveViewportDefault(spaces, 'repo', undefined, '社内 PC'),
			paradisResolveViewportDefault(spaces, 'worktree', 'repo', '社内 PC'),
			paradisResolveViewportDefault(spaces, 'other', undefined, '社内 PC'),
			paradisResolveViewportDefault(spaces, 'unknown', undefined, ' 社内 PC '),
			paradisResolveViewportDefault(spaces, undefined, undefined, ''),
		], [
			{ spec: 'iPhone 15', source: 'space' },
			{ spec: 'iPhone 15', source: 'parentSpace' },
			{ spec: '', source: 'space' },
			{ spec: '社内 PC', source: 'global' },
			{ spec: '', source: 'none' },
		]);
	});

	test('matches a default to the row it names', () => {
		assert.deepStrictEqual([
			paradisViewportSpecMatches('社内 PC', { kind: 'size', size: SIZES[0] }, SIZES),
			paradisViewportSpecMatches('1366x768', { kind: 'size', size: SIZES[0] }, SIZES),
			paradisViewportSpecMatches('1366x768', { kind: 'size', size: { width: 1366, height: 768 } }, SIZES),
			paradisViewportSpecMatches('', { kind: 'fit' }, SIZES),
			paradisViewportSpecMatches('社内 PC', { kind: 'fit' }, SIZES),
		], [true, false, true, true, false]);
	});

	test('reads only valid stored sizes, drops duplicate names, and refuses names that look like a size', () => {
		assert.deepStrictEqual([
			paradisParseViewportSizes(JSON.stringify([
				{ name: 'A', width: 1000, height: 700, mobile: true, deviceScaleFactor: 2 },
				{ name: 'a', width: 1200, height: 700 },
				{ name: '1366x768', width: 1366, height: 768 },
				{ name: 'B', width: 20, height: 700 },
				'junk',
			])),
			paradisParseViewportSizes('not json'),
			paradisParseViewportSizes(undefined),
		], [
			[{ name: 'A', width: 1000, height: 700, mobile: true, deviceScaleFactor: 2 }],
			undefined,
			undefined,
		]);
		assert.deepStrictEqual(['  社内　PC ', 'auto', '', 'x'.repeat(41)].map(name => paradisSanitizeViewportName(name)), ['社内 PC', undefined, undefined, undefined]);
	});

	test('shapes the LLM answers', () => {
		assert.deepStrictEqual({
			viewport: paradisViewportForAgent({ fit: true, width: 1240, height: 860, mobile: false }),
			ok: paradisFormatSetViewportResult('7f2c', 'iPhone 15', { ok: true, previous: { fit: true, width: 1240, height: 860, mobile: false }, viewport: { fit: false, name: 'iPhone 15', width: 390, height: 844, mobile: true } }).text,
			unknown: paradisFormatSetViewportResult('7f2c', 'Galaxy', { ok: false, reason: 'unknownViewport' }).error?.startsWith('"Galaxy" is neither'),
		}, {
			viewport: { width: 1240, height: 860, mobile: false, fit: true },
			ok: 'Tab 7f2c is now "iPhone 15" (390x844, mobile) (was auto (follows the editor, now 1240x860)). The size chip in the address bar shows it to the user.',
			unknown: true,
		});
	});
});

suite('paradisBrowserViewportCdp', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('folds device metrics like upstream, keeps the user agent, and uses the screen DPR for 1 or less', () => {
		assert.deepStrictEqual([
			paradisFoldDeviceMetricsOverride({ userAgent: 'UA', mobile: true }, { width: 1350, height: 940, deviceScaleFactor: 1, mobile: false }),
			paradisFoldDeviceMetricsOverride(undefined, { width: 412, height: 823, deviceScaleFactor: 1.75, mobile: true }),
			paradisFoldDeviceMetricsOverride(undefined, { width: 0, height: 0, deviceScaleFactor: 0 }),
		], [
			{ userAgent: 'UA', width: 1350, height: 940 },
			{ width: 412, height: 823, mobile: true, deviceScaleFactor: 1.75 },
			{},
		]);
	});

	test('puts back the size from before the CDP command, unless someone changed it since', () => {
		const ledger = new ParadisAgentEmulationLedger();
		const userSize = { width: 1366, height: 768 };
		// emulate twice on the same connection, then the connection closes: back to the user's size
		const first = ledger.apply('view', 'cdp-1', userSize, { width: 390, height: 844 });
		const second = ledger.apply('view', 'cdp-1', first, { width: 412, height: 915 });
		const restored = ledger.release('view', 'cdp-1', second);
		// emulate, then the user picks another size on the chip: the closing connection leaves it alone
		ledger.apply('view', 'cdp-2', undefined, { width: 390, height: 844 });
		const kept = ledger.release('view', 'cdp-2', { width: 1920, height: 1080 });
		// another connection does not undo it
		const applied = ledger.apply('view', 'cdp-3', undefined, { width: 390, height: 844 });
		const otherOwner = ledger.release('view', 'cdp-4', applied);
		assert.deepStrictEqual({ restored, kept, otherOwner, remaining: ledger.size }, {
			restored: { kind: 'restore', device: userSize },
			kept: { kind: 'keep' },
			otherOwner: { kind: 'keep' },
			remaining: 1,
		});
	});

	test('two connections in turn: the size from before the first one comes back once the last owner closes, whichever closes first', () => {
		const original = { width: 1366, height: 768 };
		const run = (firstToClose: 'a' | 'b') => {
			const ledger = new ParadisAgentEmulationLedger();
			let device: ReturnType<typeof paradisFoldDeviceMetricsOverride> | undefined = original;
			device = ledger.apply('view', 'a', device, { width: 390, height: 844 });
			device = ledger.apply('view', 'b', device, { width: 412, height: 915 });
			for (const owner of firstToClose === 'a' ? ['a', 'b'] : ['b', 'a']) {
				const release = ledger.release('view', owner, device);
				if (release.kind === 'restore') {
					device = release.device;
				}
			}
			return device;
		};
		assert.deepStrictEqual({ aFirst: run('a'), bFirst: run('b') }, { aFirst: original, bFirst: original });
	});

	test('keeps the agent colour scheme next to the pointer the device decides, and scales input and screenshots to the page', () => {
		assert.deepStrictEqual({
			mobile: paradisMergeEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'pointer', value: 'fine' }] }, { width: 390, height: 844, mobile: true }),
			noDevice: paradisMergeEmulatedMedia({ media: 'print', features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, undefined),
			cleared: paradisMergeEmulatedMedia(undefined, { width: 1366, height: 768 }),
			input: paradisScaleCdpInputCoordinates({ type: 'mouseWheel', x: 10, y: 20, deltaY: 100, touchPoints: [{ x: 2, y: 4 }] }, 0.5),
			unscaled: paradisScaleCdpInputCoordinates({ x: 10, y: 20 }, 1),
			// 1920x1080 drawn at 31% on a DPR 2 screen -> 1190x670 image, returned at the page size
			viewport: paradisEmulatedScreenshotSize({ width: 1190, height: 670 }, { width: 1920, height: 1080 }, undefined),
			rect: paradisEmulatedScreenshotSize({ width: 62, height: 31 }, { width: 1920, height: 1080 }, { width: 100, height: 50 }),
			same: paradisEmulatedScreenshotSize({ width: 390, height: 844 }, { width: 390, height: 844 }, undefined),
		}, {
			mobile: { media: '', features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'pointer', value: 'coarse' }] },
			noDevice: { media: 'print', features: [{ name: 'prefers-color-scheme', value: 'dark' }] },
			cleared: { media: '', features: [{ name: 'pointer', value: 'fine' }] },
			input: { type: 'mouseWheel', x: 5, y: 10, deltaY: 50, touchPoints: [{ x: 1, y: 2 }] },
			unscaled: { x: 10, y: 20 },
			viewport: { width: 1920, height: 1081 },
			rect: { width: 100, height: 50 },
			same: undefined,
		});
	});
});
