/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { nativeImage } from 'electron';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { browserViewBitmapHasVisibleAlpha } from '../../../../../platform/browserView/common/browserViewScreenshot.js';

suite('Paradis screenshot NativeImage validation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses byte offset 3 as alpha for semantic transparent and opaque PNG fixtures', () => {
		// These fixtures were encoded independently of Electron: transparent black and opaque black.
		const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64');
		const opaquePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
		const transparentBitmap = nativeImage.createFromBuffer(transparentPng).toBitmap();
		const opaqueBitmap = nativeImage.createFromBuffer(opaquePng).toBitmap();

		assert.strictEqual(transparentBitmap.length, 4);
		assert.strictEqual(opaqueBitmap.length, 4);
		assert.strictEqual(transparentBitmap[3], 0);
		assert.strictEqual(opaqueBitmap[3], 255);
		assert.strictEqual(browserViewBitmapHasVisibleAlpha(transparentBitmap), false);
		assert.strictEqual(browserViewBitmapHasVisibleAlpha(opaqueBitmap), true);
	});

});
