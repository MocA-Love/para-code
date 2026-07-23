// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Hermes has no crypto.getRandomValues。@para/protocol の @noble/* が内部で使うため、
// アプリの他のどのコードよりも先にポリフィルを読み込む必要がある（package.json の
// main をこのファイルにし、expo-router/entry より前に import する）。
import 'react-native-get-random-values';
import './src/sentry.js';
import 'expo-router/entry';
