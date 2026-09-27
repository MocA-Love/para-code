// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// このリポジトリのTypeScriptソースは（src/vs や app/protocol と同様）相対importに明示的な
// `.js` 拡張子を書く規約（moduleResolution: "bundler" 前提のESM記法）を使っている。
// Metroバンドラーは既定でこの `.js` 指定を実ファイルの `.ts`/`.tsx` へ解決しないため、
// `.js` で終わる相対importだけ `.ts`/`.tsx` を先に試すリゾルバを追加する。

const path = require('path');
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname, {
	annotateReactComponents: false,
	includeWebReplay: false,
	includeWebFeedback: false,
	autoWrapExpoRouterErrorBoundary: true,
});
const upstreamResolveRequest = config.resolver.resolveRequest;

// このプロジェクト自身のコード（app/mobile/index.ts, app/mobile/src, app/mobile/app,
// ワークスペース内の @para/protocol）だけを対象にする。expo-router 等の内部が生成する相対requireまで
// 書き換えてしまうと、ルーター自身の解決ロジックを壊しうるため範囲を厳密に絞る。
const OWN_CODE_FILES = [
	path.join(__dirname, 'index.ts'),
];
const OWN_CODE_ROOTS = [
	path.join(__dirname, 'src'),
	path.join(__dirname, 'app'),
	path.join(__dirname, '..', 'protocol', 'src'),
];

function isOwnCode(originModulePath) {
	return OWN_CODE_FILES.includes(originModulePath) || OWN_CODE_ROOTS.some(root => originModulePath.startsWith(root + path.sep));
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

// PC 版と共有している依存なしのモジュールを、モバイルは `src/vs` から直接 import している
// （例: fileViewer.tsx が読む Office ビューアの復旧状態機械 paradisOfficeRecovery.ts）。
// Metro は watchFolders の外のファイルを解決しないため、その置き場所だけを加える。
// `src/vs` 全体を加えると VS Code 本体の巨大なツリーを監視することになるので、ディレクトリ単位で足す。
//
// この watchFolders が export（`expo export:embed`、Xcode の "Bundle React Native code and images"）でも
// 効くのは、app.json の `experiments.onDemandFilesystem: false` があるから。既定（true）のままだと
// @expo/cli の withMetroMultiPlatformAsync が export 時だけ watchFolders を [projectRoot] に切り詰め、
// 残りを遅延読み込み（fallback）に任せる。その fallback は serverRoot（app/）の外へ出られないため、
// リポジトリ直下の src/vs は「存在しない」扱いになり、開発サーバーでは通るのに export だけ解決に失敗する。
config.watchFolders = [
	...(config.watchFolders ?? []),
	path.join(__dirname, '..', '..', 'src', 'vs', 'paradis', 'contrib', 'fileViewers', 'common'),
];

module.exports = config;
