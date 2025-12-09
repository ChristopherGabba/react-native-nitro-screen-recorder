import type { HybridObject } from 'react-native-nitro-modules';
import type { CameraDevice, RecorderCameraStyle, PermissionResponse, ScreenRecordingFile, ScreenRecordingEvent, PermissionStatus, BroadcastPickerPresentationEvent } from './types';
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
    getCameraPermissionStatus(): PermissionStatus;
    getMicrophonePermissionStatus(): PermissionStatus;
    requestCameraPermission(): Promise<PermissionResponse>;
    requestMicrophonePermission(): Promise<PermissionResponse>;
    addScreenRecordingListener(ignoreRecordingsInitiatedElsewhere: boolean, callback: (event: ScreenRecordingEvent) => void): number;
    removeScreenRecordingListener(id: number): void;
    addBroadcastPickerListener(callback: (event: BroadcastPickerPresentationEvent) => void): number;
    removeBroadcastPickerListener(id: number): void;
    startInAppRecording(enableMic: boolean, enableCamera: boolean, cameraPreviewStyle: RecorderCameraStyle, cameraDevice: CameraDevice, separateAudioFile: boolean, onRecordingFinished: (file: ScreenRecordingFile) => void): void;
    stopInAppRecording(): Promise<ScreenRecordingFile | undefined>;
    cancelInAppRecording(): Promise<void>;
    /**
     * Starts global screen recording (iOS: broadcast extension, Android: MediaProjection).
     *
     * @param enableMic - Whether to enable microphone recording
     * @param separateAudioFile - Whether to save audio as a separate file
     * @param timeoutMs - How long to wait for recording to start (default: 120000ms / 2 minutes)
     * @returns Promise that resolves with:
     *   - `true` if recording started successfully
     *   - `undefined` if user dismissed/cancelled or timed out
     * @throws Error if there's an actual failure (permissions, app group issues, etc.)
     */
    startGlobalRecording(enableMic: boolean, separateAudioFile: boolean, timeoutMs: number): Promise<boolean | undefined>;
    stopGlobalRecording(settledTimeMs: number): Promise<ScreenRecordingFile | undefined>;
    retrieveLastGlobalRecording(): ScreenRecordingFile | undefined;
    clearRecordingCache(): void;
}
//# sourceMappingURL=NitroScreenRecorder.nitro.d.ts.map