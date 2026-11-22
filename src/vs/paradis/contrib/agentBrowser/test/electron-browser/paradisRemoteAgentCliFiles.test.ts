/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { PARADIS_AGENT_CLI_SKILL_CONTENT } from '../../common/paradisAgentCliSkill.js';
import { paradisSyncRemoteAgentCliFiles } from '../../electron-browser/paradisRemoteAgentCliFiles.js';

suite('paradisRemoteAgentCliFiles', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const claudeSkill = ['.claude', 'skills', 'para-cli', 'SKILL.md'];
	const codexSkill = ['.agents', 'skills', 'para-cli', 'SKILL.md'];
	const codexRules = ['.codex', 'rules', 'para-code.rules'];

	test('on an SSH host the window writes the same files to the default folders and removes only its own', async () => {
		const disposables = store.add(new DisposableStore());
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.vscodeRemote, disposables.add(new InMemoryFileSystemProvider())));
		const remoteHome = URI.from({ scheme: Schemas.vscodeRemote, authority: 'ssh-remote+host', path: '/home/dev' });
		const text = async (...segments: string[]) => fileService.readFile(joinPath(remoteHome, ...segments)).then(content => content.value.toString(), () => undefined);

		await fileService.createFolder(remoteHome);
		const noAgents = await paradisSyncRemoteAgentCliFiles(fileService, remoteHome, true);
		const createdForNoAgents = (await fileService.resolve(remoteHome)).children?.length;
		await fileService.createFolder(joinPath(remoteHome, '.claude'));
		await fileService.createFolder(joinPath(remoteHome, '.codex'));
		await fileService.writeFile(joinPath(remoteHome, ...codexRules), VSBuffer.fromString('# mine\n'));
		const installed = await paradisSyncRemoteAgentCliFiles(fileService, remoteHome, true);
		const afterInstall = [await text(...claudeSkill) === PARADIS_AGENT_CLI_SKILL_CONTENT, await text(...codexSkill) === PARADIS_AGENT_CLI_SKILL_CONTENT, await text(...codexRules)];
		const again = await paradisSyncRemoteAgentCliFiles(fileService, remoteHome, true);
		const removed = await paradisSyncRemoteAgentCliFiles(fileService, remoteHome, false);

		assert.deepStrictEqual({ noAgents, createdForNoAgents, installed, afterInstall, again, removed, afterRemove: [await text(...claudeSkill), await text(...codexSkill), await text(...codexRules)] }, {
			noAgents: 0, createdForNoAgents: 0, installed: 2, afterInstall: [true, true, '# mine\n'], again: 0, removed: 2, afterRemove: [undefined, undefined, '# mine\n'],
		});
	});
});
