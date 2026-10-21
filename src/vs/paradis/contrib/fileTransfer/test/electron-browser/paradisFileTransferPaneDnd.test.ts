/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { IDragAndDropData } from '../../../../../base/browser/dnd.js';
import { ElementsDragAndDropData, NativeDragAndDropData } from '../../../../../base/browser/ui/list/listView.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPaneEntry } from '../../common/paradisFileTransferListing.js';
import { createParadisPaneDragAndDrop, IParadisPaneDropTarget, paradisExternalDropPaths, paradisExternalTransferSource } from '../../electron-browser/paradisFileTransferPaneDnd.js';

const remoteFolder = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+dev', path: '/home/dev/project' });
const localEntry: IParadisPaneEntry = { name: 'a.txt', resource: URI.file('/Users/example/a.txt'), kind: 'file', isDirectory: false, size: 1, mtime: 0, mode: undefined };

/** 片側の受け口。受けたものを書き留める。 */
function dropTarget(side: 'local' | 'remote', canReceive: boolean, log: string[]): IParadisPaneDropTarget {
	return {
		location: side === 'remote' ? remoteFolder : URI.file('/Users/example'),
		owns: resource => (resource.scheme === 'file') === (side === 'local'),
		canReceive: () => canReceive,
		showDropCaption: (_targetDirectory, count) => log.push(`caption ${count}`),
		hideDropCaption: () => { },
		receive: (entries, targetDirectory) => log.push(`entries ${entries.map(entry => entry.name).join(',')} -> ${targetDirectory.path}`),
		acceptsExternalFiles: () => side === 'remote' && canReceive,
		receiveExternalFiles: (paths, targetDirectory) => log.push(`external ${paths.join(',')} -> ${targetDirectory.path}`),
	};
}

/** Finder から来たファイル（`Files` を持つ）か、表どうしのドラッグ（`text/plain` だけ）の DragEvent。 */
function dragEvent(type: 'dragover' | 'drop', external: boolean): DragEvent {
	const dataTransfer = new DataTransfer();
	if (external) {
		dataTransfer.items.add(new File(['x'], 'a.txt'));
		dataTransfer.items.add(new File([], 'folder'));
		// Finder は名前などの文字列も一緒に持ってくることがある（ファイルの数には入れない）
		dataTransfer.setData('text/plain', 'a.txt');
	} else {
		dataTransfer.setData('text/plain', localEntry.resource.toString());
	}
	return new DragEvent(type, { dataTransfer });
}

suite('Paradis file transfer - pane drag and drop', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts external files only on the remote side, and keeps the drag between the tables', () => {
		const results: Record<string, { readonly over: boolean; readonly log: readonly string[] }> = {};
		const cases: [string, 'local' | 'remote', boolean, boolean, boolean?][] = [
			['remote / external', 'remote', true, true],
			['remote / external / no local path', 'remote', true, true, true],
			['remote / external / disconnected', 'remote', false, true],
			['local / external', 'local', true, true],
			['remote / from the left table', 'remote', true, false],
			['local / from the left table (same side)', 'local', true, false],
		];
		for (const [name, side, canReceive, external, noPath] of cases) {
			const log: string[] = [];
			// フォルダーには大きさも種類も無いが、パスは取れる
			const dnd = createParadisPaneDragAndDrop(dropTarget(side, canReceive, log), file => noPath ? '' : `/Users/example/${file.name}`);
			const data: IDragAndDropData = external ? new NativeDragAndDropData() : new ElementsDragAndDropData([localEntry]);
			const reaction = dnd.onDragOver!(data, undefined, undefined, undefined, dragEvent('dragover', external));
			dnd.drop(data, undefined, undefined, undefined, dragEvent('drop', external));
			results[name] = { over: typeof reaction === 'boolean' ? reaction : reaction.accept, log };
		}
		assert.deepStrictEqual(results, {
			'remote / external': { over: true, log: ['caption 2', 'external /Users/example/a.txt,/Users/example/folder -> /home/dev/project'] },
			'remote / external / no local path': { over: true, log: ['caption 2', 'external  -> /home/dev/project'] },
			'remote / external / disconnected': { over: false, log: [] },
			'local / external': { over: false, log: [] },
			'remote / from the left table': { over: true, log: ['caption 1', 'entries a.txt -> /home/dev/project'] },
			'local / from the left table (same side)': { over: false, log: [] },
		});
	});

	test('collects local paths and builds the same transfer source as the left table', () => {
		const files = [new File(['x'], 'a.txt'), new File([], 'b'), new File([], 'a.txt'), new File([], 'web.png')];
		const paths = paradisExternalDropPaths(files, file => file.name === 'web.png' ? '' : `/Users/example/${file.name}`);
		assert.deepStrictEqual({
			paths,
			none: paradisExternalDropPaths(undefined, () => 'x'),
			file: paradisExternalTransferSource('/Users/example/a.txt', { isDirectory: false, size: 1, mtime: 5 }),
			folder: paradisExternalTransferSource('/Users/example/b', { isDirectory: true, size: 4096, mtime: 6 }),
		}, {
			paths: ['/Users/example/a.txt', '/Users/example/b'],
			none: [],
			file: { resource: URI.file('/Users/example/a.txt'), name: 'a.txt', isDirectory: false, size: 1, mtime: 5 },
			folder: { resource: URI.file('/Users/example/b'), name: 'b', isDirectory: true, size: undefined, mtime: 6 },
		});
	});
});
