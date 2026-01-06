import type { ScreenRecordingFile, PermissionResponse, InAppRecordingInput, ScreenRecordingEvent, PermissionStatus, GlobalRecordingInput, BroadcastPickerPresentationEvent, ExtensionStatus } from './types';
/**
 * Gets the current camera permission status without requesting permission.
 *
 * @platform iOS, Android
 * @returns The current permission status for camera access
 * @example
 * ```typescript
 * const status = getCameraPermissionStatus();
 * if (status === 'granted') {
 *   // Camera is available
 * }
 * ```
 */
export declare function getCameraPermissionStatus(): PermissionStatus;
/**
 * Gets the current microphone permission status without requesting permission.
 *
 * @platform iOS, Android
 * @returns The current permission status for microphone access
 * @example
 * ```typescript
 * const status = getMicrophonePermissionStatus();
 * if (status === 'granted') {
 *   // Microphone is available
 * }
 * ```
 */
export declare function getMicrophonePermissionStatus(): PermissionStatus;
/**
 * Requests camera permission from the user if not already granted.
 * Shows the system permission dialog if permission hasn't been determined.
 *
 * @platform iOS, Android
 * @returns Promise that resolves with the permission response
 * @example
 * ```typescript
 * const response = await requestCameraPermission();
 * if (response.status === 'granted') {
 *   // Permission granted, can use camera
 * }
 * ```
 */
export declare function requestCameraPermission(): Promise<PermissionResponse>;
/**
 * Requests microphone permission from the user if not already granted.
 * Shows the system permission dialog if permission hasn't been determined.
 *
 * @platform iOS, Android
 * @returns Promise that resolves with the permission response
 * @example
 * ```typescript
 * const response = await requestMicrophonePermission();
 * if (response.status === 'granted') {
 *   // Permission granted, can record audio
 * }
 * ```
 */
export declare function requestMicrophonePermission(): Promise<PermissionResponse>;
/**
 * Starts in-app screen recording with the specified configuration.
 * Records only the current app's content, not system-wide screen content.
 *
 * @platform iOS
 * @param input Configuration object containing recording options and callbacks
 * @returns Promise that resolves when recording starts successfully
 * @example
 * ```typescript
 * await startInAppRecording({
 *   options: {
 *     enableMic: true,
 *     enableCamera: true,
 *     cameraDevice: 'front',
 *     cameraPreviewStyle: { width: 100, height: 150, top: 30, left: 10 }
 *   },
 *   onRecordingFinished: (file) => {
 *     console.log('Recording saved:', file.path);
 *   }
 * });
 * ```
 */
export declare function startInAppRecording(input: InAppRecordingInput): Promise<void>;
/**
 * Stops the current in-app recording and saves the recorded video.
 * The recording file will be provided through the onRecordingFinished callback.
 *
 * @platform iOS-only
 * @example
 * ```typescript
 * stopInAppRecording(); // File will be available in onRecordingFinished callback
 * ```
 */
export declare function stopInAppRecording(): Promise<ScreenRecordingFile | undefined>;
/**
 * Cancels the current in-app recording without saving the video.
 * No file will be generated and onRecordingFinished will not be called.
 *
 * @platform iOS-only
 * @example
 * ```typescript
 * cancelInAppRecording(); // Recording discarded, no file saved
 * ```
 */
export declare function cancelInAppRecording(): Promise<void>;
/**
 * Starts global screen recording that captures the entire device screen.
 * Records system-wide content, including other apps and system UI.
 * Requires screen recording permission on iOS.
 *
 * @platform iOS, Android
 * @example
 * ```typescript
 * startGlobalRecording();
 * // User can now navigate to other apps while recording continues
 * ```
 */
export declare function startGlobalRecording(input: GlobalRecordingInput): void;
/**
 * Stops the current global screen recording and saves the video.
 * The recorded file can be retrieved using retrieveLastGlobalRecording().
 *
 * @platform Android/ios
 * @param options.settledTimeMs A "delay" time to wait before the function
 * tries to retrieve the file from the asset writer. It can take some time
 * to finish completion and correclty return the file. Default = 500ms
 * @example
 * ```typescript
 * const file = await stopGlobalRecording({ settledTimeMs: 1000 });
 * if (file) {
 *   console.log('Global recording saved:', file.path);
 * }
 * ```
 */
export declare function stopGlobalRecording(options?: {
    settledTimeMs: number;
}): Promise<ScreenRecordingFile | undefined>;
/**
 * Marks the start of a new recording chunk during a global recording session.
 * Discards any content recorded since the last markChunkStart() or finalizeChunk() call,
 * and begins recording to a fresh file.
 *
 * Use this to indicate "I care about content starting NOW". Any previously recorded
 * but uncommitted content will be discarded.
 *
 * @platform iOS-only
 * @example
 * ```typescript
 * startGlobalRecording({ onRecordingError: console.error });
 * // User navigates around (content is recorded but uncommitted)
 * markChunkStart(); // "I care about content starting NOW"
 * // User does something important...
 * const chunk = await finalizeChunk(); // Get the chunk
 * ```
 */
export declare function markChunkStart(): void;
/**
 * Discards any content recorded since the last markChunkStart() or finalizeChunk() call,
 * and begins recording to a fresh file. This is an alias for markChunkStart().
 *
 * Use this when you want to throw away recorded content without saving it.
 *
 * @platform iOS-only
 * @example
 * ```typescript
 * markChunkStart(); // Start tracking
 * // User does something...
 * flushChunk(); // Oops, discard that, start fresh
 * // User does something else...
 * const chunk = await finalizeChunk(); // Save this instead
 * ```
 */
export declare function flushChunk(): void;
/**
 * Finalizes the current recording chunk and returns it, then starts a new chunk.
 * The recording session continues uninterrupted.
 *
 * Returns the video file containing content from the last markChunkStart() (or recording start)
 * until now. Recording continues in a new file after this call.
 *
 * @platform iOS-only
 * @param options.settledTimeMs A "delay" time to wait before retrieving the file. Default = 500ms
 * @returns Promise resolving to the finalized chunk file
 * @example
 * ```typescript
 * markChunkStart();
 * // ... user does something important ...
 * const chunk1 = await finalizeChunk();
 * await uploadToServer(chunk1);
 *
 * // Recording continues...
 * const chunk2 = await finalizeChunk();
 * await uploadToServer(chunk2);
 * ```
 */
export declare function finalizeChunk(options?: {
    settledTimeMs: number;
}): Promise<ScreenRecordingFile | undefined>;
/**
 * Retrieves the most recently completed global recording file.
 * Returns undefined if no global recording has been completed.
 *
 * @platform iOS, Android
 * @returns The last global recording file or undefined if none exists
 * @example
 * ```typescript
 * const lastRecording = retrieveLastGlobalRecording();
 * if (lastRecording) {
 *   console.log('Duration:', lastRecording.duration);
 *   console.log('File size:', lastRecording.size);
 * }
 * ```
 */
export declare function retrieveLastGlobalRecording(): ScreenRecordingFile | undefined;
/**
 * Adds a listener for screen recording events (began, ended, etc.).
 * Returns a cleanup function to remove the listener when no longer needed.
 *
 * @platform iOS, Android
 * @param listener Callback function that receives screen recording events
 * @returns Cleanup function to remove the listener
 * @example
 * ```typescript
 * useEffect(() => {
 *  const removeListener = addScreenRecordingListener((event: ScreenRecordingEvent) => {
 *    console.log("Event type:", event.type, "Event reason:", event.reason)
 *  });
 * // Later, remove the listener
 * return () => removeListener();
 * },[])
 * ```
 */
export declare function addScreenRecordingListener({ listener, ignoreRecordingsInitiatedElsewhere, }: {
    listener: (event: ScreenRecordingEvent) => void;
    ignoreRecordingsInitiatedElsewhere: boolean;
}): () => void;
/**
 * Adds a listener for ios only to track whether (start, stop, error, etc.).
 * Returns a cleanup function to remove the listener when no longer needed.
 *
 * @platform iOS
 * @param listener Callback function that receives the status of the BroadcastPickerView
 * on ios
 * @returns Cleanup function to remove the listener
 * @example
 * ```typescript
 * useEffect(() => {
 *  const removeListener = addBroadcastPickerListener((event: BroadcastPickerPresentationEvent) => {
 *    console.log("Picker status", event)
 *  });
 * // Later, remove the listener
 * return () => removeListener();
 * },[])
 * ```
 */
export declare function addBroadcastPickerListener(listener: (event: BroadcastPickerPresentationEvent) => void): () => void;
/**
 * Gets the current status of the broadcast extension.
 * Useful for monitoring if the extension is alive and processing buffers.
 *
 * @platform iOS-only
 * @returns ExtensionStatus object with isAlive, isMicActive, isCapturing, lastHeartbeat, and chunkStartedAt
 * @example
 * ```typescript
 * const status = getExtensionStatus();
 * if (status.isAlive) {
 *   console.log('Extension is running');
 *   console.log('Mic active:', status.isMicActive);
 *   console.log('Capturing:', status.isCapturing);
 *   if (status.chunkStartedAt > 0) {
 *     const elapsed = Date.now() / 1000 - status.chunkStartedAt;
 *     console.log('Recording for:', elapsed, 'seconds');
 *   }
 * }
 * ```
 */
export declare function getExtensionStatus(): ExtensionStatus;
/**
 * Clears all cached recording files to free up storage space.
 * This will delete temporary files but not files that have been explicitly saved.
 *
 * @platform iOS, Android
 * @example
 * ```typescript
 * clearCache(); // Frees up storage by removing temporary recording files
 * ```
 */
export declare function clearCache(): void;
//# sourceMappingURL=functions.d.ts.map