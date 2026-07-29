/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { WebContents, WebFrameMain } from 'electron';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_MIRROR_CAPTURE_ENV,
	ParadisBrowserMirrorCapture,
} from '../../electron-main/paradisBrowserMirrorCaptureCore.js';

function webContentsWith(frame: WebFrameMain | null, destroyed = false): WebContents {
	return {
		isDestroyed: () => destroyed,
		mainFrame: frame,
	} as unknown as WebContents;
}

suite('Paradis browser mirror capture', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const initialMirrorCaptureEnvironment = process.env[PARADIS_MIRROR_CAPTURE_ENV];

	setup(() => {
		delete process.env[PARADIS_MIRROR_CAPTURE_ENV];
	});

	teardown(() => {
		delete process.env[PARADIS_MIRROR_CAPTURE_ENV];
		sinon.restore();
		if (initialMirrorCaptureEnvironment === undefined) {
			delete process.env[PARADIS_MIRROR_CAPTURE_ENV];
		} else {
			process.env[PARADIS_MIRROR_CAPTURE_ENV] = initialMirrorCaptureEnvironment;
		}
	});

	test('returns the exact armed target frame', () => {
		const expectedFrame = Object.freeze({ target: 'expected' }) as unknown as WebFrameMain;
		const { capture, targetWebContents } = createCaptureHarness();
		targetWebContents.set('target-expected', webContentsWith(expectedFrame));

		capture.arm('target-expected');

		assert.strictEqual(capture.resolve(), expectedFrame);
	});

	test('denies an armed target mismatch without consulting multiple environment fallback candidates', () => {
		const firstUnrelatedFrame = Object.freeze({ target: 'unrelated-1' }) as unknown as WebFrameMain;
		const secondUnrelatedFrame = Object.freeze({ target: 'unrelated-2' }) as unknown as WebFrameMain;
		const { capture, fallbackWebContents, fallbackLookupCount } = createCaptureHarness();
		fallbackWebContents.push(
			webContentsWith(firstUnrelatedFrame),
			webContentsWith(secondUnrelatedFrame),
		);
		process.env[PARADIS_MIRROR_CAPTURE_ENV] = 'fallback-enabled';

		capture.arm('target-missing');

		assert.strictEqual(capture.resolve(), 'deny');
		assert.strictEqual(fallbackLookupCount(), 0);
	});

	test('denies an armed target whose web contents is destroyed or has no frame', () => {
		const { capture, targetWebContents } = createCaptureHarness();
		targetWebContents.set('target-destroyed', webContentsWith(Object.freeze({}) as unknown as WebFrameMain, true));
		targetWebContents.set('target-without-frame', webContentsWith(null));

		capture.arm('target-destroyed');
		assert.strictEqual(capture.resolve(), 'deny');

		capture.arm('target-without-frame');
		assert.strictEqual(capture.resolve(), 'deny');
	});

	test('consumes a successful arm exactly once', () => {
		const expectedFrame = Object.freeze({ target: 'one-shot' }) as unknown as WebFrameMain;
		const { capture, targetWebContents } = createCaptureHarness();
		targetWebContents.set('target-one-shot', webContentsWith(expectedFrame));

		capture.arm('target-one-shot');

		assert.strictEqual(capture.resolve(), expectedFrame);
		assert.strictEqual(capture.resolve(), undefined);
	});

	test('fails closed once after an armed request expires and consumes the arm', () => {
		const clock = sinon.useFakeTimers({ now: 1_000 });
		const expectedFrame = Object.freeze({ target: 'expired' }) as unknown as WebFrameMain;
		const { capture, targetWebContents } = createCaptureHarness();
		targetWebContents.set('target-expired', webContentsWith(expectedFrame));

		capture.arm('target-expired');
		clock.tick(15_001);

		assert.strictEqual(capture.resolve(), 'deny');
		assert.strictEqual(capture.resolve(), undefined);
	});
});

function createCaptureHarness(): {
	readonly capture: ParadisBrowserMirrorCapture;
	readonly targetWebContents: Map<string, WebContents>;
	readonly fallbackWebContents: WebContents[];
	readonly fallbackLookupCount: () => number;
} {
	const targetWebContents = new Map<string, WebContents>();
	const fallbackWebContents: WebContents[] = [];
	let fallbackLookups = 0;
	const capture = new ParadisBrowserMirrorCapture({
		fromDevToolsTargetId: targetId => targetWebContents.get(targetId),
		getAllWebContents: () => {
			fallbackLookups++;
			return fallbackWebContents;
		},
		isBrowserViewWebContents: () => true,
	});
	return {
		capture,
		targetWebContents,
		fallbackWebContents,
		fallbackLookupCount: () => fallbackLookups,
	};
}
