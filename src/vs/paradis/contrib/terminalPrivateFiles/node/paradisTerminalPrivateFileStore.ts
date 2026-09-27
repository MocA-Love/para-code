/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `IParadisTerminalPrivateFiles` の実体（node の fs）。フォルダは 0700、ファイルは 0600 で作り、
// 一時ファイルへ書いてから置き換える（書きかけのファイルを読ませない）。

import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { PARADIS_RENDER_EVIDENCE_MAX_AGE, PARADIS_RENDER_EVIDENCE_MAX_RECORDS, paradisRenderRecordName, paradisRenderRecordsToPrune } from '../../terminalRenderer/common/paradisRenderDesync.js';
import { IParadisRenderEvidence, IParadisTerminalPrivateFiles, paradisIsSafeWorkspaceId, paradisStripTerminalStateSecrets } from '../common/paradisTerminalPrivateFiles.js';

/** 受け付ける大きさの上限（renderer から来る値なので、際限なく書かせない）。 */
const MAX_SCREENS_LENGTH = 64 * 1024 * 1024;
const MAX_EVIDENCE_LENGTH = 32 * 1024 * 1024;

async function ensurePrivateDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	// 既にあったフォルダは mkdir の mode が効かないので、改めて絞る
	await fs.chmod(dir, 0o700);
}

async function writePrivateFile(file: string, content: string | Buffer): Promise<void> {
	const temp = `${file}.${generateUuid().slice(0, 8)}.tmp`;
	await fs.writeFile(temp, content, { mode: 0o600 });
	await fs.rename(temp, file);
}

async function removeQuietly(target: string): Promise<void> {
	await fs.rm(target, { recursive: true, force: true });
}

export class ParadisTerminalPrivateFileStore implements IParadisTerminalPrivateFiles {

	/**
	 * @param screensDir 保存画面のフォルダ（`<ユーザーデータ>/paradisTerminalScreens`）
	 * @param evidenceDir 描画ずれの記録のフォルダ（`<ユーザーデータ>/logs/paradisTerminalRender`）
	 */
	constructor(
		private readonly screensDir: string,
		private readonly evidenceDir: string,
		private readonly now: () => number = Date.now,
	) { }

	private screensFile(workspaceId: string): string {
		if (!paradisIsSafeWorkspaceId(workspaceId)) {
			throw new Error('invalid workspace id');
		}
		return join(this.screensDir, `${workspaceId}.json`);
	}

	async readScreens(workspaceId: string): Promise<string | undefined> {
		try {
			return await fs.readFile(this.screensFile(workspaceId), 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return undefined;
			}
			throw error;
		}
	}

	async writeScreens(workspaceId: string, content: string): Promise<void> {
		if (typeof content !== 'string' || content.length > MAX_SCREENS_LENGTH) {
			throw new Error('invalid screens content');
		}
		const file = this.screensFile(workspaceId);
		const saved = JSON.parse(content) as { state?: unknown };
		if (!saved || typeof saved !== 'object' || typeof saved.state !== 'string') {
			throw new Error('invalid screens content');
		}
		// 内部用の環境変数とペイントークンは、renderer を信じずにここで落とす
		const stripped = JSON.stringify({ ...saved, state: paradisStripTerminalStateSecrets(saved.state) });
		await ensurePrivateDir(this.screensDir);
		await writePrivateFile(file, stripped);
	}

	async deleteScreens(workspaceId: string): Promise<void> {
		await removeQuietly(this.screensFile(workspaceId));
	}

	async sweepScreens(maxAge: number): Promise<void> {
		let names: string[];
		try {
			names = await fs.readdir(this.screensDir);
		} catch {
			return;
		}
		const now = this.now();
		for (const name of names) {
			const file = join(this.screensDir, name);
			try {
				const stat = await fs.stat(file);
				// 書きかけのまま残った一時ファイルも一緒に片付く
				if (now - stat.mtimeMs > maxAge) {
					await removeQuietly(file);
				}
			} catch {
				// 消えた
			}
		}
	}

	async writeRenderEvidence(evidence: IParadisRenderEvidence): Promise<string | undefined> {
		const total = (evidence.beforePng?.length ?? 0) + (evidence.afterPng?.length ?? 0) + (evidence.info?.length ?? 0);
		if (typeof evidence.info !== 'string' || total > MAX_EVIDENCE_LENGTH) {
			throw new Error('invalid render evidence');
		}
		await ensurePrivateDir(this.evidenceDir);
		const now = this.now();
		// 期限切れ（7日）を消し、残りも上限（4件）に収まるよう古いものから消す
		const names = (await fs.readdir(this.evidenceDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
		const alive: string[] = [];
		for (const name of names) {
			try {
				const stat = await fs.stat(join(this.evidenceDir, name));
				if (now - stat.mtimeMs > PARADIS_RENDER_EVIDENCE_MAX_AGE) {
					await removeQuietly(join(this.evidenceDir, name));
				} else {
					alive.push(name);
				}
			} catch {
				// 消えた
			}
		}
		for (const name of paradisRenderRecordsToPrune(alive, PARADIS_RENDER_EVIDENCE_MAX_RECORDS - 1)) {
			await removeQuietly(join(this.evidenceDir, name));
		}
		const folder = join(this.evidenceDir, paradisRenderRecordName(now, generateUuid()));
		await fs.mkdir(folder, { mode: 0o700 });
		if (evidence.beforePng) {
			await writePrivateFile(join(folder, 'before.png'), Buffer.from(evidence.beforePng, 'base64'));
		}
		if (evidence.afterPng) {
			await writePrivateFile(join(folder, 'after.png'), Buffer.from(evidence.afterPng, 'base64'));
		}
		await writePrivateFile(join(folder, 'info.json'), evidence.info);
		return folder;
	}
}
