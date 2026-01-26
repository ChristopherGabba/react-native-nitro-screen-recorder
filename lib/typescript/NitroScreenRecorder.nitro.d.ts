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
    markChunkStart(chunkId: string | undefined): void;
    finalizeChunk(settledTimeMs: number): Promise<ScreenRecordingFile | undefined>;
    retrieveLastGlobalRecording(): ScreenRecordingFile | undefined;
    retrieveGlobalRecording(chunkId: string | undefined): ScreenRecordingFile | undefined;
    getExtensionStatus(): RawExtensionStatus;
    isScreenBeingRecorded(): boolean;
    clearRecordingCache(): void;
}
//# sourceMappingURL=NitroScreenRecorder.nitro.d.ts.map