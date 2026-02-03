import type { HybridObject } from 'react-native-nitro-modules';
import type { CameraDevice, RecorderCameraStyle, PermissionResponse, ScreenRecordingFile, ScreenRecordingEvent, PermissionStatus, RecordingError, BroadcastPickerPresentationEvent, RawExtensionStatus } from './types';
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
    startGlobalRecording(enableMic: boolean, separateAudioFile: boolean, onRecordingError: (error: RecordingError) => void): void;
    stopGlobalRecording(settledTimeMs: number): Promise<ScreenRecordingFile | undefined>;
    markChunkStart(chunkId: string | undefined): Promise<number>;
    finalizeChunk(chunkId: string | undefined, settledTimeMs: number): Promise<ScreenRecordingFile | undefined>;
    retrieveLastGlobalRecording(): ScreenRecordingFile | undefined;
    retrieveGlobalRecording(chunkId: string | undefined): ScreenRecordingFile | undefined;
    getExtensionStatus(): RawExtensionStatus;
    isScreenBeingRecorded(): boolean;
    /**
     * Returns logs from the broadcast extension for debugging.
     * @platform iOS-only
     */
    getExtensionLogs(): string[];
    /**
     * Clears all extension logs from UserDefaults.
     * @platform iOS-only
     */
    clearExtensionLogs(): void;
    /**
     * Returns audio metrics from the broadcast extension as JSON for Sentry.
     * Includes sample counts, durations, backpressure stats, and sync deltas.
     * @platform iOS-only
     */
    getExtensionAudioMetrics(): string;
    /**
     * Clears audio metrics from UserDefaults.
     * @platform iOS-only
     */
    clearExtensionAudioMetrics(): void;
    clearRecordingCache(): void;
}
//# sourceMappingURL=NitroScreenRecorder.nitro.d.ts.map