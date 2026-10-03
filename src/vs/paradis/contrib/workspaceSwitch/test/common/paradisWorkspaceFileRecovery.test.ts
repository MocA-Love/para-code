/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ITextFileEditorModel, ITextFileService, TextFileEditorModelState } from '../../../../../workbench/services/textfile/common/textfiles.js';
import { ParadisWorkspaceFileRecoveryResult, paradisRecoverWorkspaceFileAfterFailedSave } from '../../common/paradisWorkspaceFileRecovery.js';

const configPath = URI.file('/home/example/.para-code/para.code-workspace');
const settings = { 'editor.tabSize': 2 };
/** ディスクの中身 (切り替え元の folders)。 */
const validContent = JSON.stringify({ folders: [{ path: '/workspace-a' }], settings });
/** 失敗した切り替えの書き換え (folders だけ) が残った未保存のモデル。 */
const failedSwitchContent = JSON.stringify({ folders: [{ path: '/workspace-b' }], settings });
/** 巻き戻しの書き戻しまで載った未保存のモデル (folders は今の folders と一致)。 */
const rolledBackContent = JSON.stringify({ folders: [{ path: '/workspace-a' }], settings });

interface IFakeModelState {
	error: boolean;
	conflict: boolean;
	dirty: boolean;
	content: string | undefined;
	saveSucceeds: boolean;
	readonly calls: string[];
}

function fakeModel(state: IFakeModelState): ITextFileEditorModel {
	return {
		hasState: (kind: TextFileEditorModelState) => kind === TextFileEditorModelState.ERROR ? state.error : kind === TextFileEditorModelState.CONFLICT ? state.conflict : false,
		isDirty: () => state.dirty,
		revert: async () => {
			state.calls.push('revert');
			state.error = state.conflict = state.dirty = false;
		},
		save: async (options?: { ignoreModifiedSince?: boolean; skipSaveParticipants?: boolean }) => {
			state.calls.push(`save:${options?.ignoreModifiedSince}:${options?.skipSaveParticipants}`);
			if (state.saveSucceeds) {
				state.error = state.conflict = state.dirty = false;
			}
			return state.saveSucceeds;
		},
		get textEditorModel() { return state.content === undefined ? null : { getValue: () => state.content }; },
	} satisfies Partial<Record<keyof ITextFileEditorModel, unknown>> as unknown as ITextFileEditorModel;
}

async function recover(state: IFakeModelState | undefined, disk: string | undefined): Promise<ParadisWorkspaceFileRecoveryResult> {
	const textFileService = { files: { get: () => state === undefined ? undefined : fakeModel(state) } } as unknown as ITextFileService;
	const fileService = {
		readFile: async () => {
			if (disk === undefined) {
				throw new Error('ENOENT');
			}
			return { value: VSBuffer.fromString(disk) };
		},
	} as unknown as IFileService;
	return paradisRecoverWorkspaceFileAfterFailedSave({ configPath, currentFolders: [URI.file('/workspace-a')], extUri }, textFileService, fileService, new NullLogService());
}

function state(overrides: Partial<IFakeModelState>): IFakeModelState {
	return { error: true, conflict: false, dirty: true, content: failedSwitchContent, saveSucceeds: true, calls: [], ...overrides };
}

suite('paradisRecoverWorkspaceFileAfterFailedSave', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('discards only what the failed switch wrote, overwrites a damaged disk only from an error state with the current folders, and leaves the rest alone', async () => {
		const intact = state({});
		const conflictIntact = state({ conflict: true });
		const handEdited = state({ content: JSON.stringify({ folders: [{ path: '/workspace-b' }], settings: { 'editor.tabSize': 8 } }) });
		const damaged = state({ content: rolledBackContent });
		const damagedWrongFolders = state({ content: failedSwitchContent });
		const damagedConflict = state({ conflict: true, content: rolledBackContent });
		const stillFull = state({ content: rolledBackContent, saveSucceeds: false });
		const userEdit = state({ error: false });
		const bothBroken = state({ content: '{"folders": [' });
		const results = {
			noModel: await recover(undefined, validContent),
			intact: await recover(intact, validContent),
			conflictIntact: await recover(conflictIntact, validContent),
			handEdited: await recover(handEdited, validContent),
			damaged: await recover(damaged, '{"fold'),
			missingOnDisk: await recover(state({ content: rolledBackContent }), undefined),
			damagedWrongFolders: await recover(damagedWrongFolders, '{"fold'),
			damagedConflict: await recover(damagedConflict, ''),
			stillFull: await recover(stillFull, ''),
			userEdit: await recover(userEdit, validContent),
			bothBroken: await recover(bothBroken, ''),
		};
		assert.deepStrictEqual({
			results,
			calls: {
				intact: intact.calls,
				conflictIntact: conflictIntact.calls,
				handEdited: handEdited.calls,
				damaged: damaged.calls,
				damagedWrongFolders: damagedWrongFolders.calls,
				damagedConflict: damagedConflict.calls,
				stillFull: stillFull.calls,
				userEdit: userEdit.calls,
				bothBroken: bothBroken.calls,
			},
		}, {
			results: {
				noModel: ParadisWorkspaceFileRecoveryResult.NotNeeded,
				intact: ParadisWorkspaceFileRecoveryResult.Reverted,
				conflictIntact: ParadisWorkspaceFileRecoveryResult.Reverted,
				handEdited: ParadisWorkspaceFileRecoveryResult.Failed,
				damaged: ParadisWorkspaceFileRecoveryResult.Overwritten,
				missingOnDisk: ParadisWorkspaceFileRecoveryResult.Overwritten,
				damagedWrongFolders: ParadisWorkspaceFileRecoveryResult.Failed,
				damagedConflict: ParadisWorkspaceFileRecoveryResult.Failed,
				stillFull: ParadisWorkspaceFileRecoveryResult.Failed,
				userEdit: ParadisWorkspaceFileRecoveryResult.NotNeeded,
				bothBroken: ParadisWorkspaceFileRecoveryResult.Failed,
			},
			calls: {
				// ディスクとの差が folders だけ＝失敗した切り替えの書き換えだけなので捨てる。
				intact: ['revert'],
				conflictIntact: ['revert'],
				// folders 以外 (設定) にも差がある＝手の編集。捨てない。
				handEdited: [],
				// 壊れたディスクの中身で読み直すと設定ごと失うので、モデルの中身で上書きする。
				damaged: ['save:true:true'],
				// モデルの folders が今の folders と違う。上書きしない。
				damagedWrongFolders: [],
				// 競合はディスクを書いたのが自分とは限らない。上書きしない。
				damagedConflict: [],
				stillFull: ['save:true:true'],
				userEdit: [],
				bothBroken: [],
			},
		});
	});
});
