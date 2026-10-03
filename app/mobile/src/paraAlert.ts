// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Alert } from 'react-native';
import { dismissPresentedAlerts } from '../modules/para-ipad-input/index.js';
import { isAppLockedNow, onAppLockChange } from './appLockState.js';
import { createParaAlert } from './paraAlertCore.js';

/**
 * アプリの Alert。**`Alert.alert` / `Alert.prompt` を直接呼ばず、必ずこれを使う**（`appLockPolicy.test.ts` が検査する）。
 * 引数は RN の `Alert.alert` / `Alert.prompt` と同じ。ロック中は出さず、ロックしたら閉じ、解除後に出し直す
 * （仕組みは `paraAlertCore.ts`）。
 */
export const paraAlert = createParaAlert(Alert, { isLocked: isAppLockedNow, onChange: onAppLockChange }, dismissPresentedAlerts);
