// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export { generateIdentity, createInitiator, respondHandshake, randomToken, SecureChannel, deriveNotifyKey, sealNotify, openNotify } from './crypto.js';
export type { Identity, InitiatorHandshake, ResponderHandshake } from './crypto.js';
export { encodePairingUri, decodePairingUri, deriveSasCode, PAIRING_URI_SCHEME } from './pairing.js';
export type { PairingPayload } from './pairing.js';
export { Channels, encodeFrame, decodeFrame } from './frames.js';
export type { ChannelId, Frame } from './frames.js';
export { FrameMux } from './mux.js';
export type { FrameHandler, FrameMuxOptions } from './mux.js';
export { toBase64, toBase64Url, fromBase64Url, concatBytes, bytesEqual } from './util.js';
export { BROWSER_JPEG_BINARY_ENCODING, decodeBinaryBrowserJpegFrame, isBinaryBrowserJpegFrame } from './browserFrame.js';
export type { BrowserJpegFrame } from './browserFrame.js';
export { FS_BINARY_RESPONSE_ENCODING, decodeBinaryFsResponse, isBinaryFsResponse } from './fileResponse.js';
export type { BinaryFsResponse, BinaryFsResponseType } from './fileResponse.js';
export { FS_BINARY_UPLOAD_ENCODING, decodeBinaryFsUpload, encodeBinaryFsUpload, isBinaryFsUpload } from './fileUpload.js';
export type { BinaryFsUpload, BinaryFsUploadMetadata } from './fileUpload.js';
export { TERMINAL_BINARY_DATA_ENCODING, decodeBinaryTerminalData, encodeBinaryTerminalData, isBinaryTerminalData } from './terminalData.js';
export type { BinaryTerminalData, BinaryTerminalDataMetadata } from './terminalData.js';
export { RELAY_DATA_VERSION, MOBILE_ID_LENGTH, packPcData, unpackPcData, mobileIdToString, mobileIdFromString, encodeRelayControl, decodeRelayControl } from './relay.js';
export type { RelayControlMessage } from './relay.js';
export { encodeNotify, decodeNotify, encodeNotifyDismiss, encodeNotifyDismissed, decodeNotifyControl } from './notify.js';
export type { NotifyKind, NotifyPayload, NotifyControlMessage } from './notify.js';
