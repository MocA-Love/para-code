/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_DEVTOOLS_LOCAL_PATH_ARGUMENTS, paradisDevtoolsPathArguments, paradisDevtoolsPathDecision, paradisDevtoolsRoots } from '../../node/paradisDevtoolsPathPolicy.js';

const REMOTE = { paneKnown: true, remote: true };
const LOCAL = { paneKnown: true, remote: false };
const UNKNOWN = { paneKnown: false, remote: false };

/** Every path argument of every tool, each passed on its own, with the decision's kind. */
function decideEachPathArgument(caller: typeof REMOTE): Record<string, string> {
	const decisions: Record<string, string> = {};
	for (const [tool, names] of PARADIS_DEVTOOLS_LOCAL_PATH_ARGUMENTS) {
		for (const name of names) {
			const args = { [name]: join(tmpdir(), 'para-code-space', 'out.txt') };
			decisions[`${tool}.${name}`] = paradisDevtoolsPathDecision(caller, tool, paradisDevtoolsPathArguments(tool, args)).kind;
		}
	}
	return decisions;
}

suite('ParadisDevtoolsPathPolicy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('refuses every local path argument from a remote (SSH) pane', () => {
		assert.deepStrictEqual(decideEachPathArgument(REMOTE), {
			'close_heapsnapshot.filePath': 'refuse',
			'compare_heapsnapshots.baseFilePath': 'refuse',
			'compare_heapsnapshots.currentFilePath': 'refuse',
			'evaluate_script.filePath': 'refuse',
			'get_heapsnapshot_class_nodes.filePath': 'refuse',
			'get_heapsnapshot_details.filePath': 'refuse',
			'get_heapsnapshot_dominators.filePath': 'refuse',
			'get_heapsnapshot_duplicate_strings.filePath': 'refuse',
			'get_heapsnapshot_edges.filePath': 'refuse',
			'get_heapsnapshot_retainers.filePath': 'refuse',
			'get_heapsnapshot_retaining_paths.filePath': 'refuse',
			'get_heapsnapshot_summary.filePath': 'refuse',
			'get_network_request.requestFilePath': 'refuse',
			'get_network_request.responseFilePath': 'refuse',
			'install_extension.path': 'refuse',
			'lighthouse_audit.outputDirPath': 'refuse',
			'performance_start_trace.filePath': 'refuse',
			'performance_stop_trace.filePath': 'refuse',
			'screencast_start.filePath': 'refuse',
			'take_heapsnapshot.filePath': 'refuse',
			'take_screenshot.filePath': 'refuse',
			'take_snapshot.filePath': 'refuse',
			'upload_file.filePath': 'refuse',
		});
	});

	test('forwards local path arguments from a local pane and refuses them from an unidentified pane', () => {
		const kinds = (caller: typeof LOCAL) => [...new Set(Object.values(decideEachPathArgument(caller)))];
		assert.deepStrictEqual({ local: kinds(LOCAL), unknown: kinds(UNKNOWN) }, { local: ['forward'], unknown: ['refuse'] });
	});

	test('explains the refusal and the inline alternative to a remote agent', () => {
		assert.deepStrictEqual([
			paradisDevtoolsPathDecision(REMOTE, 'evaluate_script', ['filePath']),
			paradisDevtoolsPathDecision(REMOTE, 'get_network_request', ['requestFilePath', 'responseFilePath']),
		], [
			{ kind: 'refuse', message: 'evaluate_script was not run: `filePath` would be a path on the user\'s local machine (where Para Code runs), not on this remote host, and Para Code does not accept local file paths from agents running on a remote host (SSH). Without `filePath` the result is returned inline.' },
			{ kind: 'refuse', message: 'get_network_request was not run: `requestFilePath`, `responseFilePath` would be paths on the user\'s local machine (where Para Code runs), not on this remote host, and Para Code does not accept local file paths from agents running on a remote host (SSH). Without `requestFilePath` / `responseFilePath` the bodies are returned inline.' },
		]);
	});

	test('lets calls without a path through, and treats unknown *Path arguments as paths', () => {
		assert.deepStrictEqual({
			noPath: paradisDevtoolsPathDecision(REMOTE, 'take_screenshot', paradisDevtoolsPathArguments('take_screenshot', { format: 'png', filePath: undefined })).kind,
			emptyString: paradisDevtoolsPathArguments('take_snapshot', { filePath: '' }),
			futureArgument: paradisDevtoolsPathArguments('some_future_tool', { exportPath: '/x', reportDirPath: '/y', url: 'https://example.com' }),
			notAnObject: paradisDevtoolsPathArguments('take_snapshot', ['filePath']),
		}, {
			noPath: 'forward',
			emptyString: ['filePath'],
			futureArgument: ['exportPath', 'reportDirPath'],
			notAnObject: [],
		});
	});

	test('builds roots from absolute pane folders plus the temporary folder', () => {
		const space = join(tmpdir(), 'para-code-space');
		const temporaryDirectory = join(tmpdir(), 'para-code-devtools-test');
		assert.deepStrictEqual({
			local: paradisDevtoolsRoots([space, 'relative/folder', space], temporaryDirectory),
			remote: paradisDevtoolsRoots([], temporaryDirectory),
		}, {
			local: [
				{ uri: pathToFileURL(space).href, name: 'workspace' },
				{ uri: pathToFileURL(temporaryDirectory).href, name: 'Para Code temporary files' },
			],
			remote: [
				{ uri: pathToFileURL(temporaryDirectory).href, name: 'Para Code temporary files' },
			],
		});
	});
});
