/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの台帳。どのビルドの常駐が、どの pid で、どのソケットに居るかを記録する。
//
// 台帳が要るのは、**ソケットの名前だけでは古い常駐を見つけられない**から。ソケット名には
// ビルドを混ぜてあるので、更新後のアプリは自分のソケット名しか計算できず、更新前の常駐が
// 居ることに気づけない。1つのディレクトリに全ビルドぶんを並べておけば、そこを読むだけで
// 「今このマシンに何が残っているか」が分かる。
//
// 書く側は不意に死ぬ (アプリごと落とされる、電源が切れる) ので、**壊れた台帳が残っている
// 前提**で読む。読み手は1件ずつ検証し、駄目なものは黙って捨てる
// (`paradisParseDaemonRecord`)。台帳が壊れていることでアプリの起動が止まってはいけない。

import { promises as fs } from 'fs';
import { dirname, join } from '../../../../base/common/path.js';
import { IParadisPtyDaemonRecord, paradisParseDaemonRecord } from '../common/paradisPtyDaemonPolicy.js';

/**
 * 台帳へ名乗る。
 *
 * 一時ファイルへ書いてから rename する。rename は同じディレクトリ内なら不可分なので、
 * 「読んだら書きかけだった」が起きない。読み手が壊れた台帳に耐えるのとは別に、そもそも
 * 壊れたものを見せない。
 */
export async function paradisWriteDaemonRecord(file: string, record: IParadisPtyDaemonRecord): Promise<void> {
	await fs.mkdir(dirname(file), { recursive: true });
	const temp = `${file}.${record.pid}.tmp`;
	await fs.writeFile(temp, JSON.stringify(record), 'utf8');
	await fs.rename(temp, file);
}

/** 台帳から名前を消す。既に無ければ何もしない。 */
export async function paradisRemoveDaemonRecord(file: string): Promise<void> {
	try {
		await fs.unlink(file);
	} catch {
		// 消えていれば目的は果たされている。
	}
}

/**
 * このマシンに残っている常駐を全部読む。ビルドを問わない。
 *
 * 返す順は台帳の並び順に依存しないよう、起動が新しい順に揃える (UI にそのまま出せる形)。
 */
export async function paradisReadDaemonRecords(dir: string): Promise<IParadisPtyDaemonRecord[]> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		// まだ誰も常駐したことがない。
		return [];
	}
	const records: IParadisPtyDaemonRecord[] = [];
	for (const name of names) {
		if (!name.endsWith('.json')) {
			continue;
		}
		try {
			const raw = await fs.readFile(join(dir, name), 'utf8');
			const record = paradisParseDaemonRecord(JSON.parse(raw));
			if (record) {
				records.push(record);
			}
		} catch {
			// 壊れている・読めない台帳は無いものとして扱う。消しには行かない
			// (書いている最中かもしれず、他人の書きかけを消す権利はこちらに無い)。
		}
	}
	return records.sort((a, b) => b.startedAt - a.startedAt);
}

/** 台帳のファイル名。{@link paradisReadDaemonRecords} が拾える形に揃える。 */
export function paradisDaemonRecordFile(dir: string, buildKey: string): string {
	return join(dir, `${buildKey}.json`);
}
