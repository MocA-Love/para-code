/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AGENT_HOST_LABEL_FORMATTER, toAgentHostUri } from '../../../../../platform/agentHost/common/agentHostUri.js';
import { TestEnvironmentService, TestLifecycleService, TestPathService, TestRemoteAgentService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { TestContextService, TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { LabelService } from '../../../../../workbench/services/label/common/labelService.js';
import { getChangesEditorFileStats, getChangesEditorLabels } from '../../browser/changesEditorLabels.js';

suite('ChangesEditorLabels', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createLabelService(): LabelService {
		const labelService = disposables.add(new LabelService(
			TestEnvironmentService,
			new TestContextService(),
			new TestPathService(URI.file('/Users/test')),
			new TestRemoteAgentService(),
			disposables.add(new TestStorageService()),
			disposables.add(new TestLifecycleService())
		));
		disposables.add(labelService.registerFormatter(AGENT_HOST_LABEL_FORMATTER));
		return labelService;
	}

	test('labels are derived from the display file URI, not the backing git blob URI', () => {
		const labelService = createLabelService();
		const displayUri = toAgentHostUri(URI.file('/workspaces/demo/src/app.ts'), 'remotehost');
		const backingUri = toAgentHostUri(URI.from({
			scheme: 'git-blob',
			path: '/workspaces/demo/src/app.ts',
			query: JSON.stringify({
				sessionUri: 'session-db://session-123',
				sha: 'abc123',
				repoRelativePath: 'src/app.ts',
			}),
		}), 'remotehost');

		assert.deepStrictEqual({
			display: getChangesEditorLabels(displayUri, labelService),
			backing: getChangesEditorLabels(backingUri, labelService),
		}, {
			display: {
				label: 'app.ts',
				description: '/workspaces/demo/src',
			},
			backing: {
				label: 'app.ts',
				description: '/workspaces/demo/src',
			},
		});
	});

	test('root-level wrapped git blob URIs do not expose the empty-authority placeholder', () => {
		const labelService = createLabelService();
		const wrappedGitBlobUri = toAgentHostUri(URI.from({
			scheme: 'git-blob',
			path: '/hello_count.txt',
			query: JSON.stringify({
				sessionUri: 'copilotcli:/62a7348d-686c-4c62-9019-dab388e8868f',
				sha: 'e911392f5dc4ea151cc013f47c9b7c8bd7a14ea6',
			}),
		}), 'local');

		assert.deepStrictEqual(getChangesEditorLabels(wrappedGitBlobUri, labelService), {
			label: 'hello_count.txt',
			description: '',
		});
	});

	test('file stats resolve from canonical, modified, and original resources', () => {
		const canonicalResource = URI.file('/workspace/renamed.ts');
		const originalResource = URI.file('/workspace/original.ts');
		const modifiedResource = URI.file('/workspace/modified.ts');
		const changes = [{
			uri: canonicalResource,
			originalUri: originalResource,
			modifiedUri: modifiedResource,
			insertions: 12,
			deletions: 3,
		}];

		assert.deepStrictEqual({
			canonical: getChangesEditorFileStats(canonicalResource, changes),
			modified: getChangesEditorFileStats(modifiedResource, changes),
			original: getChangesEditorFileStats(originalResource, changes),
			unrelated: getChangesEditorFileStats(URI.file('/workspace/unrelated.ts'), changes),
		}, {
			canonical: { insertions: 12, deletions: 3 },
			modified: { insertions: 12, deletions: 3 },
			original: { insertions: 12, deletions: 3 },
			unrelated: undefined,
		});
	});

	// PARA-PATCH: tests below pin the behaviour the indexed lookup has to keep matching the
	// upstream linear `find` on (first change wins, all candidate URIs resolve). See
	// changesEditorLabels.ts.
	test('file stats resolve the first change when a URI appears in several changes', () => {
		// 索引化(先勝ちルール)でも旧 find と同じ「最初の要素」を採用する
		const changes = [
			{ originalUri: undefined, modifiedUri: URI.file('/workspace/dup.ts'), insertions: 1, deletions: 2 },
			{ originalUri: undefined, modifiedUri: URI.file('/workspace/dup.ts'), insertions: 30, deletions: 40 },
		];
		assert.deepStrictEqual(getChangesEditorFileStats(URI.file('/workspace/dup.ts'), changes), { insertions: 1, deletions: 2 });
	});

	test('chat session file changes resolve from all three resources with optional ones missing', () => {
		const changes = [{
			uri: URI.file('/workspace/chat-uri.ts'),
			modifiedUri: URI.file('/workspace/b2.ts'),
			insertions: 5,
			deletions: 6,
		}];
		assert.deepStrictEqual({
			chatUri: getChangesEditorFileStats(URI.file('/workspace/chat-uri.ts'), changes),
			modified: getChangesEditorFileStats(URI.file('/workspace/b2.ts'), changes),
			missingOriginal: getChangesEditorFileStats(URI.file('/workspace/original-missing.ts'), changes),
		}, {
			chatUri: { insertions: 5, deletions: 6 },
			modified: { insertions: 5, deletions: 6 },
			missingOriginal: undefined,
		});
	});
});
