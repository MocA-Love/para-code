/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { EventType } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { AppResourcePath, FileAccess } from '../../../../../base/common/network.js';
import { ipcRenderer } from '../../../../../base/parts/sandbox/electron-browser/globals.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { installParadisFocusQuieting, PARADIS_POINTER_FOCUS_CLASS } from '../../browser/paradisFocusRing.js';

// 本家の workbench の規則（src/vs/workbench/browser/media/style.css の Keyboard Focus Indication Styles）と同じもの。
// テストの画面には読み込まれないので、ここで同じ規則を足す。fork の画面の CSS が使うテーマの色も入れる
// （未定義の var() を含む outline は無効になり、枠が無いように見えてしまう）。
const WORKBENCH_FOCUS_RULE = `.monaco-workbench { --vscode-focusBorder: red; } .monaco-workbench [tabindex="0"]:focus, .monaco-workbench [tabindex="-1"]:focus, .monaco-workbench select:focus, .monaco-workbench button:focus, .monaco-workbench input[type="text"]:focus, .monaco-workbench input[type="checkbox"]:focus { outline-width: 1px; outline-style: solid; outline-offset: -1px; outline-color: red; }`;

// 読み込む CSS: この機能の規則と、確かめる fork の画面の実物の CSS（自前のフォーカスの規則と一緒に効くかを見る）。
const STYLESHEETS: AppResourcePath[] = [
	'vs/paradis/contrib/focusRing/browser/media/paradisFocusRing.css',
	'vs/paradis/contrib/terminalPresets/browser/media/paradisPresetEditorDialog.css',
	'vs/paradis/contrib/paradisSettings/electron-browser/media/paradisSettingsDialog.css',
	'vs/paradis/contrib/resourceMonitor/electron-browser/media/paradisResourceMonitor.css',
	'vs/paradis/contrib/usageDashboard/electron-browser/media/paradisUsageDashboard.css',
	'vs/paradis/contrib/paradisHub/electron-browser/media/paradisHub.css',
	'vs/paradis/browser/media/paradisSwitch.css',
	'vs/paradis/contrib/ccusage/electron-browser/media/paradisCcusage.css',
];

function loadStylesheet(path: AppResourcePath): Promise<HTMLLinkElement> {
	const link = mainWindow.document.createElement('link');
	link.rel = 'stylesheet';
	link.href = FileAccess.asBrowserUri(path).toString(true);
	const loaded = new Promise<HTMLLinkElement>((resolve, reject) => {
		link.addEventListener('load', () => resolve(link), { once: true });
		link.addEventListener('error', () => reject(new Error(`could not load ${path}`)), { once: true });
	});
	mainWindow.document.head.appendChild(link);
	return loaded;
}

/** `:focus` は文書にフォーカスがあるときだけ当たるので、テストの窓にフォーカスを入れる（inlineEditInputBox.test.ts と同じ手順）。 */
async function setWebContentsFocus(): Promise<void> {
	const changed = mainWindow.document.hasFocus()
		? undefined
		: new Promise<void>(resolve => mainWindow.addEventListener(EventType.FOCUS, () => resolve(), { once: true }));
	await ipcRenderer.invoke('vscode:test-set-web-contents-focus', true);
	await changed;
}

suite('Paradis focus ring', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let workbench: HTMLElement;
	let style: HTMLStyleElement;
	let links: HTMLLinkElement[] = [];

	setup(async () => {
		await setWebContentsFocus();
		style = mainWindow.document.createElement('style');
		style.textContent = WORKBENCH_FOCUS_RULE;
		mainWindow.document.head.prepend(style);
		workbench = mainWindow.document.createElement('div');
		workbench.className = 'monaco-workbench';
		mainWindow.document.body.appendChild(workbench);
		links = await Promise.all(STYLESHEETS.map(loadStylesheet));
		store.add(installParadisFocusQuieting(mainWindow));
	});

	teardown(() => {
		workbench.remove();
		style.remove();
		for (const link of links) {
			link.remove();
		}
		links = [];
	});

	function make(html: string): void {
		workbench.innerHTML = html; // test-only fixture markup
	}

	/** フォーカスしたときの outline の線と、キーボードのフォーカスとして扱われたか。 */
	function focusOutline(id: string, focusVisible: boolean): { outline: string; keyboard: boolean } {
		const element = mainWindow.document.getElementById(id)!;
		element.blur();
		element.focus({ focusVisible } as FocusOptions);
		return { outline: mainWindow.getComputedStyle(element).outlineStyle, keyboard: element.matches(':focus-visible') };
	}

	/** マウスで押したとき（focusVisible: false）と Tab で移ったとき（true）の outline の線。 */
	function mouseAndKeyboard(id: string): string {
		return `${focusOutline(id, false).outline} ${focusOutline(id, true).outline}`;
	}

	test('fork controls drop the frame only for non-keyboard focus; upstream controls, look-alike classes and text inputs keep it', () => {
		make([
			'<div class="paradis-dialog" role="dialog" tabindex="-1" id="root">',
			'<button id="forkButton">run</button>',
			'<input type="checkbox" id="forkCheck">',
			'<input type="text" id="forkText">',
			'<span tabindex="0" id="forkGrip">::</span>',
			'</div>',
			'<button class="paradis-trigger" id="forkSelfButton">cpu</button>',
			'<div class="upstream-part"><button id="upstreamButton">ok</button><button class="parameter-hints" id="lookalike">x</button></div>',
		].join(''));

		const states: Record<string, string> = {};
		for (const id of ['forkButton', 'forkCheck', 'forkGrip', 'forkSelfButton', 'upstreamButton', 'lookalike', 'forkText', 'root']) {
			states[id] = mouseAndKeyboard(id);
		}
		assert.deepStrictEqual(states, {
			forkButton: 'none solid',
			forkCheck: 'none solid',
			forkGrip: 'none solid',
			forkSelfButton: 'none solid',
			upstreamButton: 'solid solid',
			lookalike: 'solid solid',
			forkText: 'solid solid',
			root: 'none none',
		});
	});

	test('arrow-key widgets (roving tabindex), a marker left by an earlier mouse focus, and high contrast themes keep the keyboard frame', () => {
		make([
			// 使用率のグラフの区間の切り替え（paradisSystemUsageChart.ts。選んでいないボタンは tabindex="-1"）
			'<div class="paradis-sysusage-segments" role="radiogroup">',
			'<button class="paradis-sysusage-segment-button" role="radio" tabindex="0" id="segSelected">5m</button>',
			'<button class="paradis-sysusage-segment-button" role="radio" tabindex="-1" id="segOther">1h</button>',
			'</div>',
			// Office のタブ（paradisOfficeAccessibility.ts の wireParadisOfficeTabList。選んでいないタブは tabindex="-1"）
			'<div class="paradis-office-tabs" role="tablist"><button role="tab" tabindex="-1" id="officeTab">Sheet2</button></div>',
			'<div class="monaco-workbench hc-black"><div class="paradis-panel"><button id="hcButton">ok</button></div></div>',
		].join(''));

		const states: Record<string, string> = {};
		for (const id of ['segOther', 'officeTab', 'hcButton']) {
			states[id] = mouseAndKeyboard(id);
		}
		// 前のマウスのフォーカスの印が残ったまま、キーボードで入る（focusout が来ずに印が残った場合）
		const element = mainWindow.document.getElementById('segSelected')!;
		element.blur();
		element.classList.add(PARADIS_POINTER_FOCUS_CLASS);
		element.focus({ focusVisible: true } as FocusOptions);
		states.segReturned = mainWindow.getComputedStyle(element).outlineStyle;

		assert.deepStrictEqual(states, {
			segOther: 'none solid',
			officeTab: 'none solid',
			hcButton: 'solid solid',
			segReturned: 'solid',
		});
	});

	test('the real fork screens (presets, settings, title bar usage, usage dashboard) follow the same rule with their own CSS loaded', () => {
		make([
			// コマンドプリセット（paradisPresetEditorDialog.ts の行のボタンと掴み）
			'<div class="paradis-preset-editor-dialog" id="presets"><div class="ppe-row"><span class="ppe-grip" tabindex="0" id="ppeGrip">::</span>',
			'<div class="ppe-row-actions"><button class="ppe-btn" type="button" id="ppeRun">run</button><button class="ppe-btn ppe-btn-danger" type="button" id="ppeDelete">delete</button></div></div>',
			'<input class="ppe-input" type="text" id="ppeInput"></div>',
			// 統合のモーダルの設定の領域（paradisSettingsDialog.ts のスイッチとボタン）
			'<div class="paradis-hub" tabindex="-1" id="settings"><div class="paradis-settings-area"><button class="paradis-switch" type="button" role="switch" aria-checked="false" id="psdToggle"></button><button class="psd-btn" type="button" id="psdButton">open</button>',
			'<select class="psd-select" id="psdSelect"><option>a</option></select></div></div>',
			// タイトルバーの資源表示（paradisResourceMonitorWidget.ts。本家のタイトルバーの中に置かれる）
			'<div class="part titlebar"><div class="titlebar-container"><button class="paradis-resource-monitor-trigger" type="button" id="rmTrigger">CPU 97%</button></div></div>',
			// 統合のモーダルの使用量の領域（器の左のナビと、paradisCcusageSection.ts の期間の切り替え）
			'<div class="paradis-hub" tabindex="-1" id="usage"><div class="phub-nav-item" role="button" tabindex="0" id="pudNav">cost</div>',
			'<div class="paradis-ccusage-seg"><button type="button" id="ccSeg">90d</button></div></div>',
		].join(''));

		const states: Record<string, string> = {};
		for (const id of ['ppeGrip', 'ppeRun', 'ppeDelete', 'psdToggle', 'psdButton', 'psdSelect', 'rmTrigger', 'pudNav', 'ccSeg']) {
			const mouse = focusOutline(id, false);
			const keyboard = focusOutline(id, true);
			states[id] = `${mouse.keyboard ? 'kb' : 'mouse'}:${mouse.outline} ${keyboard.keyboard ? 'kb' : 'mouse'}:${keyboard.outline}`;
		}
		const containers: Record<string, string> = {};
		for (const id of ['settings', 'usage']) {
			containers[id] = focusOutline(id, true).outline;
		}
		states.ppeInput = focusOutline('ppeInput', false).outline;

		assert.deepStrictEqual({ states, containers }, {
			states: {
				ppeGrip: 'mouse:none kb:solid',
				ppeRun: 'mouse:none kb:solid',
				ppeDelete: 'mouse:none kb:solid',
				psdToggle: 'mouse:none kb:solid',
				psdButton: 'mouse:none kb:solid',
				psdSelect: 'mouse:none kb:solid',
				rmTrigger: 'mouse:none kb:solid',
				pudNav: 'mouse:none kb:solid',
				ccSeg: 'mouse:none kb:solid',
				ppeInput: 'solid',
			},
			containers: { settings: 'none', usage: 'none' },
		});
	});
});
