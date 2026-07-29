/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import type { DownloadItem, Event, Session, WebContents } from 'electron';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IConfigurationOverrides, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { paradisConfigureBrowserDownloads } from '../../electron-main/paradisBrowserDownloads.js';

type WillDownloadListener = (event: Event, item: DownloadItem, webContents: WebContents) => void;
type DownloadItemFake = Pick<DownloadItem, 'getFilename' | 'setSavePath'>;

suite('ParadisBrowserDownloads', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('creates the configured directory, contains filenames, and avoids existing files', () => {
		const temporaryRoot = fs.mkdtempSync(join(os.tmpdir(), 'paradis-browser-downloads-'));
		const targetDirectory = join(temporaryRoot, 'custom');
		let listener: WillDownloadListener | undefined;
		let listenerRegistrations = 0;
		const session = {
			on: (event: 'will-download', candidate: WillDownloadListener) => {
				assert.strictEqual(event, 'will-download');
				listener = candidate;
				listenerRegistrations++;
			},
		} satisfies { on(event: 'will-download', listener: WillDownloadListener): void };
		const getValue: IConfigurationService['getValue'] = <T>(...args: [sectionOrOverrides?: string | IConfigurationOverrides, overrides?: IConfigurationOverrides]): T => {
			const key = typeof args[0] === 'string' ? args[0] : undefined;
			if (key === 'paradis.browser.downloads.enabled') {
				return true as T;
			}
			if (key === 'paradis.browser.downloads.path') {
				return `  ${targetDirectory}  ` as T;
			}
			return undefined as T;
		};
		const configurationService = {
			getValue,
		} satisfies Pick<IConfigurationService, 'getValue'>;

		try {
			paradisConfigureBrowserDownloads(session as unknown as Session, configurationService as IConfigurationService);
			paradisConfigureBrowserDownloads(session as unknown as Session, configurationService as IConfigurationService);
			assert.strictEqual(listenerRegistrations, 1, 'a session must have only one will-download listener');
			assert.ok(listener);

			const savePaths: string[] = [];
			const screenshotItem = {
				getFilename: () => 'screenshot.png',
				setSavePath: candidate => savePaths.push(candidate),
			} satisfies DownloadItemFake;
			listener(undefined as never, screenshotItem as unknown as DownloadItem, undefined as never);
			fs.writeFileSync(join(targetDirectory, 'report.txt'), 'existing');
			fs.writeFileSync(join(targetDirectory, 'report (1).txt'), 'also existing');
			const traversalItem = {
				getFilename: () => join('..', '..', 'report.txt'),
				setSavePath: candidate => savePaths.push(candidate),
			} satisfies DownloadItemFake;
			listener(undefined as never, traversalItem as unknown as DownloadItem, undefined as never);

			assert.strictEqual(fs.statSync(targetDirectory).isDirectory(), true);
			assert.deepStrictEqual(savePaths, [
				join(targetDirectory, 'screenshot.png'),
				join(targetDirectory, 'report (2).txt'),
			]);
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});

	test('leaves Electron save handling untouched when automatic downloads are disabled', () => {
		let listener: WillDownloadListener | undefined;
		const session = {
			on: (_event: 'will-download', candidate: WillDownloadListener) => {
				listener = candidate;
			},
		} satisfies { on(event: 'will-download', listener: WillDownloadListener): void };
		const getValue: IConfigurationService['getValue'] = <T>(...args: [sectionOrOverrides?: string | IConfigurationOverrides, overrides?: IConfigurationOverrides]): T => {
			const key = typeof args[0] === 'string' ? args[0] : undefined;
			return (key === 'paradis.browser.downloads.enabled' ? false : undefined) as T;
		};
		const configurationService = {
			getValue,
		} satisfies Pick<IConfigurationService, 'getValue'>;

		paradisConfigureBrowserDownloads(session as unknown as Session, configurationService as IConfigurationService);
		assert.ok(listener);
		let savePathCalls = 0;
		const item = {
			getFilename: () => {
				throw new Error('disabled downloads must not inspect the filename');
			},
			setSavePath: () => savePathCalls++,
		} satisfies DownloadItemFake;
		listener(undefined as never, item as unknown as DownloadItem, undefined as never);

		assert.strictEqual(savePathCalls, 0);
	});
});
