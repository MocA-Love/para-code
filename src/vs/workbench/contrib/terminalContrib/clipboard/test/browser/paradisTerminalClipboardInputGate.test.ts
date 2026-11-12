/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { deepStrictEqual } from 'assert';
import { Event } from '../../../../../../base/common/event.js';
import { upcastDeepPartial, upcastPartial } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { TestClipboardService } from '../../../../../../platform/clipboard/test/common/testClipboardService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../../platform/dialogs/test/common/testDialogService.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../../platform/notification/test/common/testNotificationService.js';
import { TerminalSettingId } from '../../../../../../platform/terminal/common/terminal.js';
import { paradisBlockTerminalInput, paradisResetTerminalInputGateForTest } from '../../../../../../paradis/contrib/workspaceSwitch/browser/paradisTerminalInputGate.js';
import { ITerminalConfigurationService, ITerminalInstance, IXtermTerminal } from '../../../../terminal/browser/terminal.js';
import { ITerminalContributionContext } from '../../../../terminal/browser/terminalExtensions.js';
import { TerminalClipboardContribution } from '../../browser/terminal.clipboard.contribution.js';

/** 画像だけのクリップボードを返す。 */
class ImageOnlyClipboardService extends TestClipboardService {
	override async readImage(): Promise<Uint8Array> {
		return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
	}
}

suite('Paradis TerminalClipboardContribution image paste input gate', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let contribution: TerminalClipboardContribution;
	let inputs: string[];

	setup(() => {
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IConfigurationService, new TestConfigurationService({
			[TerminalSettingId.EnableMultiLinePasteWarning]: 'never'
		}));
		instantiationService.stub(IDialogService, new TestDialogService());
		instantiationService.stub(INotificationService, new TestNotificationService());
		instantiationService.stub(ITerminalConfigurationService, upcastPartial<ITerminalConfigurationService>({}));
		instantiationService.stub(IClipboardService, new ImageOnlyClipboardService());

		const ctx = upcastPartial<ITerminalContributionContext>({
			instance: upcastPartial<ITerminalInstance>({ focus: () => { } })
		});
		contribution = store.add(instantiationService.createInstance(TerminalClipboardContribution, ctx));
		inputs = [];
		contribution.xtermReady(upcastDeepPartial<IXtermTerminal & { raw: RawXtermTerminal }>({
			onDidRequestCopyAsHtml: Event.None,
			raw: {
				onSelectionChange: Event.None,
				modes: { bracketedPasteMode: false },
				paste: () => { },
				input: (data: string) => { inputs.push(data); }
			}
		}));
	});

	teardown(() => paradisResetTerminalInputGateForTest());

	test('does not send Ctrl+V for an image while a space switch blocks terminal input', async () => {
		await contribution.paste();
		const sentWhileOpen = [...inputs];

		inputs = [];
		const gate = paradisBlockTerminalInput();
		try {
			await contribution.paste();
		} finally {
			gate.dispose();
		}

		deepStrictEqual({ sentWhileOpen, sentWhileBlocked: inputs }, { sentWhileOpen: ['\x16'], sentWhileBlocked: [] });
	});
});
