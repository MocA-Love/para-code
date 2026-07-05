// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// このリポジトリのTypeScriptソースは（src/vs や app/protocol と同様）相対importに明示的な
// `.js` 拡張子を書く規約（moduleResolution: "bundler" 前提のESM記法）を使っている。
// Metroバンドラーは既定でこの `.js` 指定を実ファイルの `.ts`/`.tsx` へ解決しないため、
// `.js` で終わる相対importだけ `.ts`/`.tsx` を先に試すリゾルバを追加する。

const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const upstreamResolveRequest = config.resolver.resolveRequest;

// このプロジェクト自身のコード（app/mobile/src, app/mobile/app, ワークスペース内の
// @para/protocol）だけを対象にする。expo-router 等の内部が生成する相対requireまで
// 書き換えてしまうと、ルーター自身の解決ロジックを壊しうるため範囲を厳密に絞る。
const OWN_CODE_ROOTS = [
	path.join(__dirname, 'src'),
	path.join(__dirname, 'app'),
	path.join(__dirname, '..', 'protocol', 'src'),
];

function isOwnCode(originModulePath) {
	return OWN_CODE_ROOTS.some(root => originModulePath.startsWith(root + path.sep));
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
	if (moduleName.startsWith('.') && moduleName.endsWith('.js') && isOwnCode(context.originModulePath)) {
		const base = moduleName.slice(0, -'.js'.length);
		for (const ext of ['.tsx', '.ts']) {
			try {
				return context.resolveRequest(context, base + ext, platform);
			} catch {
				// このextでは無かった。次を試す。
			}
		}
	}
	if (upstreamResolveRequest) {
		return upstreamResolveRequest(context, moduleName, platform);
	}
	return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
