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
import { PARADIS_DEVTOOLS_LOCAL_PATH_ARGUMENTS, paradisDevtoolsExplainRootsDenial, paradisDevtoolsPathArguments, paradisDevtoolsPathDecision, paradisDevtoolsRoots, paradisDevtoolsUserTemporaryFolders, paradisDevtoolsVersionControlRealpathRefusal } from '../../node/paradisDevtoolsPathPolicy.js';

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

	test('refuses paths inside .git, .hg or .svn even from a local pane', () => {
		const decide = (args: Record<string, unknown>) => paradisDevtoolsPathDecision(LOCAL, 'take_screenshot', paradisDevtoolsPathArguments('take_screenshot', args), args);
		const refused = decide({ filePath: '/repos/a/.git/hooks/pre-commit' });
		assert.deepStrictEqual({
			git: refused.kind,
			explains: refused.kind === 'refuse' && refused.message.includes('.git, .hg or .svn'),
			relativeSvn: decide({ filePath: 'repo/.svn/entries' }).kind,
			github: decide({ filePath: '/repos/a/.github/shot.png' }).kind,
			plain: decide({ filePath: '/repos/a/shot.png' }).kind,
		}, { git: 'refuse', explains: true, relativeSvn: 'refuse', github: 'forward', plain: 'forward' });
	});

	test('refuses a local path that reaches .git through a symbolic link, also for a file that does not exist yet', async () => {
		// /repos/a/hooks -> /repos/a/.git/hooks, /repos/a/cfg -> /repos/a/.git/config
		const links = new Map([['/repos/a/hooks', '/repos/a/.git/hooks'], ['/repos/a/cfg', '/repos/a/.git/config']]);
		const existing = new Set(['/', '/repos', '/repos/a', '/repos/a/.git', '/repos/a/.git/hooks', '/repos/a/.git/config', '/repos/a/out']);
		const realpath = async (path: string) => {
			for (const [link, target] of links) {
				if (path === link || path.startsWith(`${link}/`)) {
					return target + path.slice(link.length);
				}
			}
			if (!existing.has(path)) {
				throw new Error('ENOENT');
			}
			return path;
		};
		const refusal = (args: Record<string, unknown>) => paradisDevtoolsVersionControlRealpathRefusal('take_screenshot', paradisDevtoolsPathArguments('take_screenshot', args), args, realpath);
		const newFileInLinkedFolder = await refusal({ filePath: '/repos/a/hooks/pre-commit' });
		assert.deepStrictEqual({
			newFileInLinkedFolder: newFileInLinkedFolder?.includes('through a symbolic link'),
			linkedFile: (await refusal({ filePath: '/repos/a/cfg' })) !== undefined,
			plain: await refusal({ filePath: '/repos/a/out/shot.png' }),
			relative: await refusal({ filePath: 'hooks/pre-commit' }),
		}, { newFileInLinkedFolder: true, linkedFile: true, plain: undefined, relative: undefined });
	});

	test('explains the refusal and the inline alternative to a remote agent', () => {
		assert.deepStrictEqual([
			paradisDevtoolsPathDecision(REMOTE, 'evaluate_script', ['filePath']),
			paradisDevtoolsPathDecision(REMOTE, 'get_network_request', ['requestFilePath', 'responseFilePath']),
		], [
			{ kind: 'refuse', message: 'evaluate_script was not run: `filePath` would refer to the user\'s local machine (where Para Code runs), not to the machine this agent runs on, and Para Code does not accept local files from agents in a remote window (SSH, WSL, container). Without `filePath` the result is returned inline.' },
			{ kind: 'refuse', message: 'get_network_request was not run: `requestFilePath`, `responseFilePath` would refer to the user\'s local machine (where Para Code runs), not to the machine this agent runs on, and Para Code does not accept local files from agents in a remote window (SSH, WSL, container). Without `requestFilePath` / `responseFilePath` the bodies are returned inline.' },
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

	test('treats a file: URL given to navigate_page as a local file, and nothing else', () => {
		assert.deepStrictEqual({
			file: paradisDevtoolsPathArguments('navigate_page', { type: 'url', url: 'file:///etc/passwd' }),
			viewSource: paradisDevtoolsPathArguments('navigate_page', { url: ' view-source:FILE:///etc/passwd' }),
			web: paradisDevtoolsPathArguments('navigate_page', { url: 'https://example.com/file:///x' }),
			remote: paradisDevtoolsPathDecision(REMOTE, 'navigate_page', ['url']).kind,
			local: paradisDevtoolsPathDecision(LOCAL, 'navigate_page', ['url']).kind,
		}, { file: ['url'], viewSource: ['url'], web: [], remote: 'refuse', local: 'forward' });
	});

	test('adds the user temporary folders for local panes, including /tmp on macOS', () => {
		assert.deepStrictEqual({
			darwin: paradisDevtoolsUserTemporaryFolders('darwin', '/var/folders/xy/T'),
			linux: paradisDevtoolsUserTemporaryFolders('linux', '/tmp'),
		}, {
			darwin: ['/var/folders/xy/T', '/tmp', '/private/tmp'],
			linux: ['/tmp'],
		});
	});

	test('explains a vendored roots denial with the allowed folders and leaves other results alone', () => {
		const space = join(tmpdir(), 'para-code-space');
		const roots = paradisDevtoolsRoots([space], join(tmpdir(), 'para-code-devtools-test'));
		const denied = { content: [{ type: 'text', text: 'Access denied: path /etc/x (canonical: /private/etc/x) is not within any of the configured workspace roots.' }], isError: true };
		const other = { content: [{ type: 'text', text: 'Access denied: Cannot resolve base path for /x.' }], isError: true };
		assert.deepStrictEqual({
			denied: paradisDevtoolsExplainRootsDenial(denied, roots),
			other: paradisDevtoolsExplainRootsDenial(other, roots) === other,
		}, {
			denied: { content: [{ type: 'text', text: `Access denied: /etc/x is outside the folders the browser tools may read and write for this terminal pane. Allowed folders: ${space}, ${join(tmpdir(), 'para-code-devtools-test')}. Use a path inside one of them, or call the tool without the path argument to get the result inline where the tool supports it (take_screenshot, take_snapshot, evaluate_script, get_network_request).` }], isError: true },
			other: true,
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
