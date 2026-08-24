/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	createParadisEditorTerminalIndicator,
	createParadisPaneIndicator,
	IParadisPaneIndicatorBoundPage,
	IParadisPaneIndicatorHost,
	ParadisPaneIndicatorState,
	setParadisHoveredPaneInstanceId,
	setParadisPaneIndicatorHost,
} from '../../browser/paradisPaneIndicator.js';

class TestHost implements IParadisPaneIndicatorHost {
	readonly onDidChangeState: Event<void> = Event.None;
	getPaneIndicatorState(): ParadisPaneIndicatorState { return 'bound'; }
	getPaneIndicatorTooltip(): string { return 'test'; }
	openBindingDialog(): void { }
	getBoundPage(): IParadisPaneIndicatorBoundPage | undefined { return undefined; }
	revealBoundPage(): void { }
}

/** グリッドセルと同じ手順（生成 → appendChild）でインジケータを取り付ける。 */
function mountIndicator(instanceId: number) {
	const cell = document.createElement('div');
	const indicator = createParadisPaneIndicator(instanceId);
	cell.appendChild(indicator.element);
	return { cell, indicator };
}

suite('ParadisPaneIndicator hover highlight', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => {
		setParadisHoveredPaneInstanceId(undefined);
		setParadisPaneIndicatorHost(undefined);
	});

	test('ホバー中に作り直されたセルにもマウント時点でハイライトが載る', async () => {
		setParadisPaneIndicatorHost(new TestHost());
		setParadisHoveredPaneInstanceId(7);

		const { cell, indicator } = mountIndicator(7);
		// マウント直後は親がまだ付いていないため、適用は次のマイクロタスクで行われる。
		await Promise.resolve();

		assert.strictEqual(cell.classList.contains('paradis-pvh-target'), true);
		indicator.dispose();
	});

	test('ホバー対象でないペインのセルにはハイライトが載らない', async () => {
		setParadisPaneIndicatorHost(new TestHost());
		setParadisHoveredPaneInstanceId(7);

		const { cell, indicator } = mountIndicator(8);
		await Promise.resolve();

		assert.strictEqual(cell.classList.contains('paradis-pvh-target'), false);
		indicator.dispose();
	});

	test('dispose するとセルからハイライトが外れる', async () => {
		setParadisPaneIndicatorHost(new TestHost());
		setParadisHoveredPaneInstanceId(7);

		const { cell, indicator } = mountIndicator(7);
		await Promise.resolve();
		indicator.dispose();

		assert.strictEqual(cell.classList.contains('paradis-pvh-target'), false);
	});
});

suite('ParadisEditorTerminalIndicator', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => {
		setParadisPaneIndicatorHost(undefined);
	});

	test('setInstance mounts/unmounts a single indicator into the shared container', () => {
		setParadisPaneIndicatorHost(new TestHost());
		const container = document.createElement('div');
		const controller = createParadisEditorTerminalIndicator(container);

		controller.setInstance(7);
		assert.strictEqual(container.querySelectorAll('.paradis-pane-indicator').length, 1);

		// タブ切り替え（別インスタンスへの retarget）で古いインジケータが残らないこと。
		controller.setInstance(8);
		assert.strictEqual(container.querySelectorAll('.paradis-pane-indicator').length, 1);

		controller.setInstance(undefined);
		assert.strictEqual(container.querySelectorAll('.paradis-pane-indicator').length, 0);

		controller.dispose();
	});

	test('dispose clears the mounted indicator', () => {
		setParadisPaneIndicatorHost(new TestHost());
		const container = document.createElement('div');
		const controller = createParadisEditorTerminalIndicator(container);

		controller.setInstance(7);
		controller.dispose();

		assert.strictEqual(container.querySelectorAll('.paradis-pane-indicator').length, 0);
	});
});
