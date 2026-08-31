/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Application, Logger } from '../../../../automation';
import { installAllHandlers } from '../../utils';
import { writeSupportedSpreadsheetFixture, writeSupportedWordFixture } from './officeFixtures';

const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
const fixtureDirectory = path.join(repositoryRoot, 'src', 'vs', 'paradis', 'contrib', 'fileViewers', 'test', 'common', 'fixtures');

export function setup(logger: Logger): void {
	describe('Para Code Office viewers', () => {
		installAllHandlers(logger, undefined, app => enableOfficeViewer(app));

		const createdFiles: string[] = [];

		afterEach(async function () {
			const app = this.app as Application;
			await app.workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
			for (const file of createdFiles.splice(0)) {
				fs.rmSync(file, { force: true });
			}
		});

		it('renders a real spreadsheet cell and diagonal border in the workbench', async function () {
			const app = this.app as Application;
			const name = 'paradis-office-smoke.xlsx';
			const target = await copyFixture(app, 'task2-diagonal-border.xlsx', name, createdFiles, writeSupportedSpreadsheetFixture);

			await openFile(app, target, name);
			const page = app.code.driver.currentPage;
			const viewer = page.locator('.paradis-spreadsheet');
			await viewer.waitFor();
			try {
				await viewer.getByText('Diagonal border', { exact: true }).waitFor();
			} catch (error) {
				throw new Error(`Spreadsheet did not render the fixture. Viewer text: ${JSON.stringify(await viewer.innerText())}`, { cause: error });
			}
			await viewer.locator('.paradis-spreadsheet-diagonal').first().waitFor();

			const bounds = await viewer.boundingBox();
			assert.ok(bounds && bounds.width > 200 && bounds.height > 100, `spreadsheet viewer bounds were ${JSON.stringify(bounds)}`);
			const screenshot = await viewer.screenshot();
			assert.ok(screenshot.byteLength > 1_000, `spreadsheet screenshot was only ${screenshot.byteLength} bytes`);
		});

		it('renders a real Word page and DrawingML overlay in its webview', async function () {
			const app = this.app as Application;
			const name = 'paradis-office-smoke.docx';
			const target = await copyFixture(app, 'task2-drawing-line.docx', name, createdFiles, writeSupportedWordFixture);

			await openFile(app, target, name);
			const page = app.code.driver.currentPage;
			const viewer = page.locator('.paradis-docx-viewer');
			await viewer.waitFor();
			const iframe = page.locator('.webview-overlay-content iframe.webview:visible').last();
			const preloadFrame = iframe.contentFrame();
			const frame = preloadFrame.locator('#active-frame').contentFrame();
			const paper = frame.locator('#content .docx-wrapper > section.docx').first();
			try {
				await paper.waitFor();
			} catch (error) {
				const iframeCount = await page.locator('.webview-overlay-content iframe.webview:visible').count();
				const rootText = await viewer.innerText();
				const frameText = iframeCount > 0 ? await frame.locator('body').innerText().catch(() => '<unavailable>') : '<missing iframe>';
				throw new Error(`Word fixture did not produce a rendered page. iframeCount=${iframeCount}, viewerText=${JSON.stringify(rootText)}, frameText=${JSON.stringify(frameText)}`, { cause: error });
			}
			await frame.getByText('Office DrawingML line fixture', { exact: true }).waitFor();
			await frame.locator('[data-paradis-drawing-id="2"].paradis-word-object-slot').waitFor();

			const bounds = await paper.boundingBox();
			assert.ok(bounds && bounds.width > 300 && bounds.height > 300, `Word page bounds were ${JSON.stringify(bounds)}`);
			const screenshot = await paper.screenshot();
			assert.ok(screenshot.byteLength > 1_000, `Word screenshot was only ${screenshot.byteLength} bytes`);
		});
	});
}

function enableOfficeViewer(app: Application): void {
	if (!app.userDataPath) {
		throw new Error('Office smoke tests require an isolated user data directory');
	}
	const userDirectory = path.join(app.userDataPath, 'User');
	const settingsPath = path.join(userDirectory, 'settings.json');
	fs.mkdirSync(userDirectory, { recursive: true });
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
	} catch {
		// A new smoke profile has no settings file yet.
	}
	settings['paradis.officeViewer.enabled'] = true;
	settings['paradis.officeViewer.engine'] = 'v1';
	fs.writeFileSync(settingsPath, JSON.stringify(settings));
}

async function copyFixture(
	app: Application,
	fixtureName: string,
	targetName: string,
	createdFiles: string[],
	writeFixture: (sourcePath: string, targetPath: string) => Promise<void>,
): Promise<string> {
	const target = path.join(app.workspacePathOrFolder, targetName);
	await writeFixture(path.join(fixtureDirectory, fixtureName), target);
	createdFiles.push(target);
	return target;
}

async function openFile(app: Application, file: string, expectedName: string): Promise<void> {
	await app.workbench.quickaccess.openFileQuickAccessAndWait(file, expectedName);
	await app.workbench.quickinput.selectQuickInputElement(0);
}
