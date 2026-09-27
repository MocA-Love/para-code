/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Verifies the CSV viewer's resolver priority against the real EditorResolverService, using the same
// harness as src/vs/workbench/services/editor/test/browser/editorResolverService.test.ts.

import { deepStrictEqual } from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { EditorResolution } from '../../../../../platform/editor/common/editor.js';
import { DEFAULT_EDITOR_ASSOCIATION, IUntypedEditorInput } from '../../../../../workbench/common/editor.js';
import { EditorResolverService } from '../../../../../workbench/services/editor/browser/editorResolverService.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { editorsAssociationsSettingId, IEditorResolverService, RegisteredEditorPriority, ResolvedStatus } from '../../../../../workbench/services/editor/common/editorResolverService.js';
import { createEditorPart, TestFileEditorInput, workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { registerParadisCsvEditors } from '../../browser/csv/paradisCsvEditorRegistration.js';

const CSV_INPUT = 'test.csvTable';
const TEXT_INPUT = 'test.defaultText';

suite('ParadisCsvEditorRegistration', () => {
	const disposables = new DisposableStore();
	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	async function resolve(configuration: Record<string, unknown>, editor: IUntypedEditorInput, enabled = true): Promise<string> {
		const instantiationService = workbenchInstantiationService({ configurationService: () => new TestConfigurationService(configuration) }, disposables);
		const part = await createEditorPart(instantiationService, disposables);
		instantiationService.stub(IEditorGroupsService, part);
		const service = disposables.add(instantiationService.createInstance(EditorResolverService));
		instantiationService.stub(IEditorResolverService, service);
		// The built-in text editor, registered the same way the workbench does (builtin priority for every file).
		disposables.add(service.registerEditor('*', { id: DEFAULT_EDITOR_ASSOCIATION.id, label: DEFAULT_EDITOR_ASSOCIATION.displayName, priority: RegisteredEditorPriority.builtin }, {}, {
			createEditorInput: ({ resource }) => ({ editor: disposables.add(new TestFileEditorInput(resource, TEXT_INPUT)) }),
		}));
		disposables.add(registerParadisCsvEditors(service, {
			isEnabled: () => enabled,
			createInput: resource => disposables.add(new TestFileEditorInput(resource, CSV_INPUT)),
		}));
		const result = await service.resolveEditor(editor, part.activeGroup);
		if (result === ResolvedStatus.NONE) {
			// The editor service then opens the resource with the text editor.
			return 'none (text editor)';
		}
		if (result === ResolvedStatus.ABORT) {
			return 'abort';
		}
		return result.editor.typeId;
	}

	test('opens CSV as a table by default but lets associations, text-only opens and the setting pick text', async () => {
		const csv = URI.file('/workspace/orders.csv');
		const tsv = URI.file('/workspace/orders.tsv');
		deepStrictEqual({
			csv: await resolve({}, { resource: csv }),
			tsv: await resolve({}, { resource: tsv }),
			associatedWithText: await resolve({ [editorsAssociationsSettingId]: { '*.csv': DEFAULT_EDITOR_ASSOCIATION.id } }, { resource: csv }),
			extensionShowTextDocument: await resolve({}, { resource: csv, options: { override: EditorResolution.EXCLUSIVE_ONLY } }),
			disabled: await resolve({}, { resource: csv }, false),
			gitScheme: await resolve({}, { resource: URI.from({ scheme: 'git', path: '/workspace/orders.csv' }) }),
		}, {
			csv: CSV_INPUT,
			tsv: CSV_INPUT,
			associatedWithText: TEXT_INPUT,
			extensionShowTextDocument: 'none (text editor)',
			disabled: TEXT_INPUT,
			gitScheme: TEXT_INPUT,
		});
	});
});
