/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot の専用フォルダ（`~/.para-code/bots/<folder>/`）の読み書き。
//
// - フォルダを作り、人格メモと記憶の種を「無いときだけ」書き、指示文の生成の範囲を書き直す（{@link ensure}）
// - フォルダの中のファイルを読む・書く（{@link read}・{@link write}）。受けるのは相対パスだけで、字面の検査の
//   後、symlink を解いた実際の場所がフォルダの中にあることをもう一度確かめる（中に置いた symlink で外を
//   読み書きさせない）
// - フォルダには持ち主の Bot の id（`.para-bot.json`）を置く。別の Bot のフォルダは使わない。Bot を消しても
//   フォルダは残るので、消した Bot の人格と記憶を、後から作った別の Bot が引き継がないようにするため

import { promises as fs } from 'fs';
import { dirname, join, sep } from '../../../../base/common/path.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';
import {
	PARADIS_BOT_AGENTS_FILE,
	PARADIS_BOT_CLAUDE_BODY,
	PARADIS_BOT_CLAUDE_FILE,
	PARADIS_BOT_MEMORY_FILE,
	PARADIS_BOT_MEMORY_FOLDER,
	PARADIS_BOT_MEMORY_SEED,
	PARADIS_BOT_OWNER_FILE,
	PARADIS_BOT_SOUL_FILE,
	paradisBotInstructions,
	paradisBotOwnerFile,
	paradisBotSoulSeed,
	paradisMergeBotGeneratedFile,
	paradisParseBotOwnerFile,
} from '../common/paradisBotHome.js';
import { IParadisBot, paradisBotHomeRelativePath, paradisIsBotFolderName } from '../common/paradisBots.js';

/** 読み書きする 1 ファイルの大きさの上限。 */
export const PARADIS_BOT_HOME_FILE_LIMIT = 1024 * 1024;

/** 専用フォルダの読み書きを断った理由。 */
export class ParadisBotHomeError extends Error {
	constructor(readonly code: 'outside' | 'not_owner' | 'too_large' | 'reserved', message: string) {
		super(message);
	}
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readText(path: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path, 'utf8');
	} catch (error) {
		if (missing(error)) {
			return undefined;
		}
		throw error;
	}
}

type HomeBot = Pick<IParadisBot, 'id' | 'name' | 'folder'>;

export class ParadisBotHomes {

	/** @param root 専用フォルダの親（`~/.para-code/bots`）。 */
	constructor(private readonly root: string) { }

	/** Bot の専用フォルダ。台帳のフォルダ名が名前の形でなければ（壊れた台帳）投げる。 */
	folder(bot: Pick<IParadisBot, 'folder'>): string {
		if (!paradisIsBotFolderName(bot.folder)) {
			throw new ParadisBotHomeError('outside', 'The bot has no valid home folder name.');
		}
		return join(this.root, bot.folder);
	}

	/** もうあるフォルダの名前。新しい Bot のフォルダを予約するとき、これも「使用中」に数える。 */
	async existingFolders(): Promise<string[]> {
		try {
			return (await fs.readdir(this.root, { withFileTypes: true })).filter(entry => !entry.isFile()).map(entry => entry.name);
		} catch (error) {
			if (missing(error)) {
				return [];
			}
			throw error;
		}
	}

	/**
	 * 専用フォルダを整える。フォルダと `memory/` を作り、持ち主の印を置き、人格メモと記憶の種を無いときだけ書き、
	 * 指示文（`AGENTS.md`・`CLAUDE.md`）の生成の範囲を書き直す。フォルダのパスを返す。
	 *
	 * @param soul 人格メモの種（テンプレートから作るとき）。もう `SOUL.md` があれば使わない
	 */
	async ensure(bot: HomeBot, soul?: string): Promise<string> {
		const home = this.folder(bot);
		await fs.mkdir(home, { recursive: true, mode: 0o700 });
		const ownerPath = join(home, PARADIS_BOT_OWNER_FILE);
		const owner = await readText(ownerPath);
		if (owner === undefined) {
			// 印の無い、中身のあるフォルダは他人のもの（消した Bot・利用者が置いたもの）として使わない
			if ((await fs.readdir(home)).length > 0) {
				throw new ParadisBotHomeError('not_owner', `The folder ${home} already has files and does not belong to this bot.`);
			}
			await paradisWriteFileAtomic(ownerPath, paradisBotOwnerFile(bot), { rejectSymlink: true });
		} else if (paradisParseBotOwnerFile(owner) !== bot.id) {
			throw new ParadisBotHomeError('not_owner', `The folder ${home} belongs to another bot.`);
		}
		await fs.mkdir(join(home, PARADIS_BOT_MEMORY_FOLDER), { recursive: true });
		await this.seed(join(home, PARADIS_BOT_SOUL_FILE), paradisBotSoulSeed(bot, soul));
		await this.seed(join(home, PARADIS_BOT_MEMORY_FILE), PARADIS_BOT_MEMORY_SEED);
		await this.generate(join(home, PARADIS_BOT_AGENTS_FILE), paradisBotInstructions(bot));
		await this.generate(join(home, PARADIS_BOT_CLAUDE_FILE), PARADIS_BOT_CLAUDE_BODY);
		return home;
	}

	/** フォルダの中のファイルを読む。無ければ undefined。外を指すパス・大きすぎるファイルは投げる。 */
	async read(bot: HomeBot, relative: unknown): Promise<string | undefined> {
		const path = await this.resolve(bot, relative, false);
		let size: number;
		try {
			size = (await fs.stat(path)).size;
		} catch (error) {
			if (missing(error)) {
				return undefined;
			}
			throw error;
		}
		if (size > PARADIS_BOT_HOME_FILE_LIMIT) {
			throw new ParadisBotHomeError('too_large', 'The file is too large to read here.');
		}
		return readText(path);
	}

	/** フォルダの中のファイルを書く（親のフォルダは作る）。持ち主の印は書き換えさせない。 */
	async write(bot: HomeBot, relative: unknown, text: string): Promise<void> {
		if (Buffer.byteLength(text, 'utf8') > PARADIS_BOT_HOME_FILE_LIMIT) {
			throw new ParadisBotHomeError('too_large', 'The text is too large to save here.');
		}
		const path = await this.resolve(bot, relative, true);
		await paradisWriteFileAtomic(path, text, { rejectSymlink: true });
	}

	/**
	 * 相対パスをフォルダの中の絶対パスにする。字面の検査の後、symlink を解いた場所がフォルダの中にあることを
	 * 確かめる（ファイルがまだ無いときは、今ある一番近い親で確かめる）。
	 */
	private async resolve(bot: HomeBot, relative: unknown, forWrite: boolean): Promise<string> {
		const clean = paradisBotHomeRelativePath(relative);
		if (clean === undefined) {
			throw new ParadisBotHomeError('outside', 'The path must be a relative path inside the bot\'s home folder.');
		}
		if (forWrite && clean === PARADIS_BOT_OWNER_FILE) {
			throw new ParadisBotHomeError('reserved', `${PARADIS_BOT_OWNER_FILE} is written by Para Code.`);
		}
		const home = this.folder(bot);
		const path = join(home, ...clean.split('/'));
		const realHome = await fs.realpath(home);
		let existing = path;
		let real: string | undefined;
		while (real === undefined) {
			try {
				real = await fs.realpath(existing);
			} catch (error) {
				if (!missing(error) || existing === home) {
					throw error;
				}
				existing = dirname(existing);
			}
		}
		if (real !== realHome && !real.startsWith(realHome + sep)) {
			throw new ParadisBotHomeError('outside', 'The path leaves the bot\'s home folder.');
		}
		// 親のフォルダを作るのは、今ある一番近い親が中にあると確かめた後（先に作ると、symlink の先に作ってしまう）
		if (forWrite) {
			await fs.mkdir(dirname(path), { recursive: true });
		}
		return path;
	}

	/** 無いときだけ書く（利用者と Bot が書いた人格メモ・記憶を上書きしない）。 */
	private async seed(path: string, text: string): Promise<void> {
		try {
			await fs.lstat(path);
		} catch (error) {
			if (!missing(error)) {
				throw error;
			}
			await paradisWriteFileAtomic(path, text, { rejectSymlink: true });
		}
	}

	/** 生成の範囲だけを書き直す。中身が変わらなければ書かない。 */
	private async generate(path: string, body: string): Promise<void> {
		if ((await fs.lstat(path).catch(() => undefined))?.isSymbolicLink()) {
			throw new ParadisBotHomeError('outside', `${path} is a symbolic link; Para Code does not write through it.`);
		}
		const existing = await readText(path);
		const next = paradisMergeBotGeneratedFile(existing, body);
		if (next !== existing) {
			await paradisWriteFileAtomic(path, next, { rejectSymlink: true });
		}
	}
}
