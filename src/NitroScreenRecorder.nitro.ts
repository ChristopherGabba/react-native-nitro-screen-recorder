import type { HybridObject } from 'react-native-nitro-modules';
import type {
  CameraDevice,
  RecorderCameraStyle,
  PermissionResponse,
  ScreenRecordingFile,
  ScreenRecordingEvent,
  PermissionStatus,
  RecordingError,
  BroadcastPickerPresentationEvent,
  ScreenRecordingSessionState,
} from './types';

/**
 * ============================================================================
 * NOTES WITH NITRO-MODULES
 * ============================================================================
 * After any change to this file, you have to run
 * `yarn prepare` in the root project folder. This
 * uses `npx expo prebuild --clean` under the hood
 *
 */

export interface NitroScreenRecorder extends HybridObject<{
  ios: 'swift';
  android: 'kotlin';
}> {
  // ============================================================================
  // PERMISSIONS
  // ============================================================================

  getCameraPermissionStatus(): PermissionStatus;
  getMicrophonePermissionStatus(): PermissionStatus;
  requestCameraPermission(): Promise<PermissionResponse>;
  requestMicrophonePermission(): Promise<PermissionResponse>;

  // ============================================================================
  // EVENT LISTENERS
  // ============================================================================

  addScreenRecordingListener(
    ignoreRecordingsInitiatedElsewhere: boolean,
    callback: (event: ScreenRecordingEvent) => void
  ): number;
  removeScreenRecordingListener(id: number): void;

  addBroadcastPickerListener(
    callback: (event: BroadcastPickerPresentationEvent) => void
  ): number;
  removeBroadcastPickerListener(id: number): void;

  // ============================================================================
  // IN-APP RECORDING
  // ============================================================================

  startInAppRecording(
    enableMic: boolean,
    enableCamera: boolean,
    cameraPreviewStyle: RecorderCameraStyle,
    cameraDevice: CameraDevice,
    onRecordingFinished: (file: ScreenRecordingFile) => void
    // onRecordingError: (error: RecordingError) => void
  ): void;
  stopInAppRecording(): Promise<ScreenRecordingFile | undefined>;
  cancelInAppRecording(): Promise<void>;

  // ============================================================================
  // SCREEN RECORDING CONSENT
  // ============================================================================

  requestScreenRecordingConsent(): Promise<boolean>;
  releaseScreenRecordingConsent(): void;
  isScreenRecordingConsentGranted(): boolean;
  getScreenRecordingSessionState(): ScreenRecordingSessionState;

  // ============================================================================
  // GLOBAL RECORDING
  // ============================================================================

  startGlobalRecording(
    enableMic: boolean,
    usePreparedConsent: boolean,
    onRecordingError: (error: RecordingError) => void
  ): void;
  stopGlobalRecording(
    settledTimeMs: number
  ): Promise<ScreenRecordingFile | undefined>;
  retrieveLastGlobalRecording(): ScreenRecordingFile | undefined;

  // ============================================================================
  // UTILITIES
  // ============================================================================

  clearRecordingCache(): void;
}
