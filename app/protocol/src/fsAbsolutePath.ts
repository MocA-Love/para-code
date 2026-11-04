// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 「絶対パスをコピー」の問い合わせ（fs.absolute-path.v1。Q548）。PC の取り決めは
 * `src/vs/paradis/contrib/mobileRelay/common/paradisMobileAbsolutePath.ts`（一致は `test/fsAbsolutePath.test.ts` が確かめる）。
 *
 * - 要求: fs の `{ t: 'absolutePath', ws, path }`（`path` はスペースのフォルダの根からの相対）
 * - 応答: `{ t: 'absolutePath', path, remote, windows }`
 * - 失敗: `{ error, code: 'invalid' | 'missing' | 'remote' }`
 *
 * アプリは押したときだけ問い合わせ、答えを端末に残さない（state にも控えにも入れない）。
 */

/** PC が広告する capability（広告しない PC には送らない）。 */
export const FS_ABSOLUTE_PATH_CAPABILITY = 'fs.absolute-path.v1';
/** 要求の種類。 */
export const FS_ABSOLUTE_PATH_KIND = 'absolutePath';

export interface FsAbsolutePathResponse {
	/** ファイルがある機械の OS で通用する絶対パス。 */
	readonly path: string;
	/** SSH などの接続先のパスか。 */
	readonly remote: boolean;
	/** Windows のパスか（`\` 区切り）。 */
	readonly windows: boolean;
}

/** 受け取る絶対パスの長さの上限（相手は信用しない）。 */
const MAX_PATH_LENGTH = 8192;

/** PC の応答を読む。形が違えば `undefined`。 */
export function parseFsAbsolutePathResponse(value: unknown): FsAbsolutePathResponse | undefined {
	if (value === null || typeof value !== 'object') {
		return undefined;
	}
	const { t, path, remote, windows } = value as Record<string, unknown>;
	if (t !== FS_ABSOLUTE_PATH_KIND || typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH || path.includes('\0')
		|| typeof remote !== 'boolean' || typeof windows !== 'boolean') {
		return undefined;
	}
	return { path, remote, windows };
}
