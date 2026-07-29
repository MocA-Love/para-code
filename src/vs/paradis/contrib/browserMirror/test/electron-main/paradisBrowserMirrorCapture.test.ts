/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { type WebContents, type WebFrameMain, webContents as electronWebContents } from 'electron';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_MIRROR_CAPTURE_ENV,
	paradisArmMirrorCapture,
	paradisResolveMirrorCaptureFrame,
} from '../../electron-main/paradisBrowserMirrorCapture.js';

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
		try {
			paradisArmMirrorCapture('test-cleanup-target');
			paradisResolveMirrorCaptureFrame();
		} finally {
			try {
				sinon.restore();
			} finally {
				if (initialMirrorCaptureEnvironment === undefined) {
					delete process.env[PARADIS_MIRROR_CAPTURE_ENV];
				} else {
					process.env[PARADIS_MIRROR_CAPTURE_ENV] = initialMirrorCaptureEnvironment;
				}
			}
		}
	});

	test('returns the exact armed target frame', () => {
		const expectedFrame = Object.freeze({ target: 'expected' }) as unknown as WebFrameMain;
		sinon.stub(electronWebContents, 'fromDevToolsTargetId').callsFake(targetId =>
			targetId === 'target-expected' ? webContentsWith(expectedFrame) : undefined,
		);

		paradisArmMirrorCapture('target-expected');

		assert.strictEqual(paradisResolveMirrorCaptureFrame(), expectedFrame);
	});

	test('denies an armed target mismatch without consulting multiple environment fallback candidates', () => {
		const firstUnrelatedFrame = Object.freeze({ target: 'unrelated-1' }) as unknown as WebFrameMain;
		const secondUnrelatedFrame = Object.freeze({ target: 'unrelated-2' }) as unknown as WebFrameMain;
		sinon.stub(electronWebContents, 'fromDevToolsTargetId').returns(undefined);
		const fallbackLookup = sinon.stub(electronWebContents, 'getAllWebContents').returns([
			webContentsWith(firstUnrelatedFrame),
			webContentsWith(secondUnrelatedFrame),
		]);
		process.env[PARADIS_MIRROR_CAPTURE_ENV] = 'fallback-enabled';

		paradisArmMirrorCapture('target-missing');

		assert.strictEqual(paradisResolveMirrorCaptureFrame(), 'deny');
		sinon.assert.notCalled(fallbackLookup);
	});

	test('denies an armed target whose web contents is destroyed or has no frame', () => {
		const lookup = sinon.stub(electronWebContents, 'fromDevToolsTargetId');
		lookup.onFirstCall().returns(webContentsWith(Object.freeze({}) as unknown as WebFrameMain, true));
		lookup.onSecondCall().returns(webContentsWith(null));

		paradisArmMirrorCapture('target-destroyed');
		assert.strictEqual(paradisResolveMirrorCaptureFrame(), 'deny');

		paradisArmMirrorCapture('target-without-frame');
		assert.strictEqual(paradisResolveMirrorCaptureFrame(), 'deny');
	});

	test('consumes a successful arm exactly once', () => {
		const expectedFrame = Object.freeze({ target: 'one-shot' }) as unknown as WebFrameMain;
		sinon.stub(electronWebContents, 'fromDevToolsTargetId').returns(webContentsWith(expectedFrame));

		paradisArmMirrorCapture('target-one-shot');

		assert.strictEqual(paradisResolveMirrorCaptureFrame(), expectedFrame);
		assert.strictEqual(paradisResolveMirrorCaptureFrame(), undefined);
	});

	test('fails closed once after an armed request expires and consumes the arm', () => {
		const clock = sinon.useFakeTimers({ now: 1_000 });
		const expectedFrame = Object.freeze({ target: 'expired' }) as unknown as WebFrameMain;
		sinon.stub(electronWebContents, 'fromDevToolsTargetId').returns(webContentsWith(expectedFrame));

		paradisArmMirrorCapture('target-expired');
		clock.tick(15_001);

		assert.strictEqual(paradisResolveMirrorCaptureFrame(), 'deny');
		assert.strictEqual(paradisResolveMirrorCaptureFrame(), undefined);
	});
});
