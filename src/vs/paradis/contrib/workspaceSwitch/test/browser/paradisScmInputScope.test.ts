/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { ISCMRepository, ISCMService } from '../../../../../workbench/contrib/scm/common/scm.js';
import { ParadisScmInputScope } from '../../browser/paradisScmInputScope.contribution.js';
import { IParadisWorkspaceSwitchService } from '../../common/paradisWorkspaceSwitch.js';

suite('ParadisScmInputScope', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface IFakeRepository {
		readonly repository: ISCMRepository;
		value: string;
	}

	function createRepository(path: string): IFakeRepository {
		const fake: IFakeRepository = {
			value: '',
			repository: upcastPartial<ISCMRepository>({
				provider: upcastPartial<ISCMRepository['provider']>({ rootUri: URI.file(path), contextValue: upcastPartial<ISCMRepository['provider']['contextValue']>({ get: () => undefined }) }),
				input: upcastPartial<ISCMRepository['input']>({
					get value() { return fake.value; },
					setValue: (value: string) => { fake.value = value; },
				}),
			}),
		};
		return fake;
	}

	function createScope() {
		const willSwitch = store.add(new Emitter<string | undefined>());
		const didSwitch = store.add(new Emitter<string>());
		const didRetire = store.add(new Emitter<string>());
		const didAddRepository = store.add(new Emitter<ISCMRepository>());
		const spaceA = createRepository('/repos/a');
		const spaceB = createRepository('/repos/b');
		// git 拡張は待避中のリポジトリも SCM に登録したままにするので、両方とも常に登録されている。
		const repositories = [spaceA.repository, spaceB.repository];
		let folders = [URI.file('/repos/b')];
		store.add(new ParadisScmInputScope(
			upcastPartial<ISCMService>({ repositories, onDidAddRepository: didAddRepository.event }),
			upcastPartial<IParadisWorkspaceSwitchService>({ onWillSwitchScope: willSwitch.event, onDidSwitchScope: didSwitch.event, onDidRetireScope: didRetire.event }),
			store.add(new InMemoryStorageService()),
			upcastPartial<IWorkspaceContextService>({ getWorkspace: () => upcastPartial<IWorkspace>({ folders: folders.map(uri => upcastPartial<IWorkspaceFolder>({ uri })) }) }),
			upcastPartial<IUriIdentityService>({ extUri }),
		));
		const switchTo = (from: string, to: string) => {
			willSwitch.fire(from);
			folders = [URI.file(`/repos/${to}`)];
			didSwitch.fire(to);
		};
		return { spaceA, spaceB, switchTo };
	}

	test('a committed message does not come back after visiting another space', () => {
		const { spaceA, spaceB, switchTo } = createScope();
		// B でメッセージを書いて A へ、B に戻ってコミット (入力欄が空になる)、もう一度 A へ、そして B へ。
		spaceB.value = 'fix: old message';
		switchTo('b', 'a');
		switchTo('a', 'b');
		spaceB.value = '';
		switchTo('b', 'a');
		const inSpaceA = { a: spaceA.value, b: spaceB.value };
		switchTo('a', 'b');
		assert.deepStrictEqual({ inSpaceA, inSpaceB: { a: spaceA.value, b: spaceB.value } }, {
			inSpaceA: { a: '', b: '' },
			inSpaceB: { a: '', b: '' },
		});
	});

	test('still brings back a draft of the space being returned to', () => {
		const { spaceA, spaceB, switchTo } = createScope();
		spaceB.value = 'feat: draft';
		switchTo('b', 'a');
		// 作り直されたリポジトリのように、入力欄が空になったところへ戻る。
		spaceB.value = '';
		switchTo('a', 'b');
		assert.deepStrictEqual({ a: spaceA.value, b: spaceB.value }, { a: '', b: 'feat: draft' });
	});
});
