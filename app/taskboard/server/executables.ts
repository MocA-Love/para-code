// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { statSync } from 'node:fs';
import * as path from 'node:path';

/*
 * Windows では、名前だけで起動したコマンド（git・gh・cmd.exe）を、PATH より先に作業フォルダから探す。
 * ボードはリポジトリや作業場所を作業フォルダにしてコマンドを起動するので、リポジトリに置かれた git.exe が
 * 動いてしまう。Windows では PATH だけから探した絶対パスで起動する（macOS と Linux は作業フォルダを探さない）。
 */

const resolved = new Map<string, string>();

function isFile(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

/** 起動するコマンドのパス。Windows では PATH だけから探した絶対パス（見つからなければ名前のまま返し、起動で失敗させる）。 */
/** @param exists テスト用（Windows のパスを、ほかの OS の上で確かめるため）。 */
export function commandPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = isFile): string {
	if (platform !== 'win32' || path.win32.isAbsolute(name)) {
		return name;
	}
	if (name.toLowerCase() === 'cmd.exe' || name.toLowerCase() === 'cmd') {
		return env.ComSpec ?? env.COMSPEC ?? path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
	}
	const cached = exists === isFile ? resolved.get(name) : undefined;
	if (cached) {
		return cached;
	}
	// .cmd・.bat はシェル無しでは起動できない（Node が断る）。Windows 自身が探すのと同じく .com と .exe だけ
	const exts = path.win32.extname(name) ? [''] : ['.COM', '.EXE'];
	for (const dir of (env.Path ?? env.PATH ?? '').split(';')) {
		// 相対の PATH（"." など）は作業フォルダを指すので使わない
		if (!dir || !path.win32.isAbsolute(dir)) {
			continue;
		}
		for (const ext of exts) {
			const candidate = path.win32.join(dir, name + ext);
			if (exists(candidate)) {
				if (exists === isFile) {
					resolved.set(name, candidate);
				}
				return candidate;
			}
		}
	}
	return name;
}
