"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.addBroadcastPickerListener = addBroadcastPickerListener;
exports.addScreenRecordingListener = addScreenRecordingListener;
exports.cancelInAppRecording = cancelInAppRecording;
exports.clearCache = clearCache;
exports.clearExtensionAudioMetrics = clearExtensionAudioMetrics;
exports.clearExtensionLogs = clearExtensionLogs;
exports.finalizeChunk = finalizeChunk;
exports.flushChunk = flushChunk;
exports.getCameraPermissionStatus = getCameraPermissionStatus;
exports.getExtensionAudioMetrics = getExtensionAudioMetrics;
exports.getExtensionLogs = getExtensionLogs;
exports.getExtensionStatus = getExtensionStatus;
exports.getMicrophonePermissionStatus = getMicrophonePermissionStatus;
exports.isScreenBeingRecorded = isScreenBeingRecorded;
exports.markChunkStart = markChunkStart;
exports.requestCameraPermission = requestCameraPermission;
exports.requestMicrophonePermission = requestMicrophonePermission;
exports.retrieveGlobalRecording = retrieveGlobalRecording;
exports.retrieveLastGlobalRecording = retrieveLastGlobalRecording;
exports.startGlobalRecording = startGlobalRecording;
exports.startInAppRecording = startInAppRecording;
exports.stopGlobalRecording = stopGlobalRecording;
exports.stopInAppRecording = stopInAppRecording;
var _reactNativeNitroModules = require("react-native-nitro-modules");
var _reactNative = require("react-native");
const NitroScreenRecorderHybridObject = _reactNativeNitroModules.NitroModules.createHybridObject('NitroScreenRecorder');
const isAndroid = _reactNative.Platform.OS === 'android';

// ============================================================================
// PERMISSIONS
// ============================================================================

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
function getCameraPermissionStatus() {
  return NitroScreenRecorderHybridObject.getCameraPermissionStatus();
}

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
function getMicrophonePermissionStatus() {
  return NitroScreenRecorderHybridObject.getMicrophonePermissionStatus();
}

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
async function requestCameraPermission() {
  return NitroScreenRecorderHybridObject.requestCameraPermission();
}

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
async function requestMicrophonePermission() {
  return NitroScreenRecorderHybridObject.requestMicrophonePermission();
}

// ============================================================================
// IN-APP RECORDING
// ============================================================================

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
async function startInAppRecording(input) {
  if (isAndroid) {
    console.warn('`startInAppRecording` is only supported on iOS.');
    return;
  }
  if (input.options.enableMic && getMicrophonePermissionStatus() !== 'granted') {
    throw new Error('Microphone permission not granted.');
  }
  if (input.options.enableCamera && getCameraPermissionStatus() !== 'granted') {
    throw new Error('Camera permission not granted.');
  }
  // Handle camera options based on enableCamera flag
  if (input.options.enableCamera) {
    return NitroScreenRecorderHybridObject.startInAppRecording(input.options.enableMic, input.options.enableCamera, input.options.cameraPreviewStyle ?? {}, input.options.cameraDevice, input.options.separateAudioFile ?? false, input.onRecordingFinished
    // input.onRecordingError
    );
  } else {
    return NitroScreenRecorderHybridObject.startInAppRecording(input.options.enableMic, input.options.enableCamera, {}, 'front', input.options.separateAudioFile ?? false, input.onRecordingFinished
    // input.onRecordingError
    );
  }
}

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
async function stopInAppRecording() {
  if (isAndroid) {
    console.warn('`stopInAppRecording` is only supported on iOS.');
    return;
  }
  return NitroScreenRecorderHybridObject.stopInAppRecording();
}

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
async function cancelInAppRecording() {
  if (isAndroid) {
    console.warn('`cancelInAppRecording` is only supported on iOS.');
    return;
  }
  return NitroScreenRecorderHybridObject.cancelInAppRecording();
}

// ============================================================================
// GLOBAL RECORDING
// ============================================================================

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
function startGlobalRecording(input) {
  // On IOS, the user grants microphone permission via a picker toggle
  // button, so we don't need this check first
  if (input.options?.enableMic && isAndroid && getMicrophonePermissionStatus() !== 'granted') {
    throw new Error('Microphone permission not granted.');
  }
  return NitroScreenRecorderHybridObject.startGlobalRecording(input?.options?.enableMic ?? false, input?.options?.separateAudioFile ?? false, input?.onRecordingError);
}

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
async function stopGlobalRecording(options) {
  let settledTimeMs = 500;
  if (options?.settledTimeMs) {
    if (typeof options.settledTimeMs !== 'number' || options.settledTimeMs <= 0) {
      console.warn('Provided invalid value to `settledTimeMs` in `stopGlobalRecording` function, value will be ignored. Please use a value >0');
    } else {
      settledTimeMs = options.settledTimeMs;
    }
  }
  return NitroScreenRecorderHybridObject.stopGlobalRecording(settledTimeMs);
}

/**
 * Marks the start of a new recording chunk during a global recording session.
 * Discards any content recorded since the last markChunkStart() or finalizeChunk() call,
 * and begins recording to a fresh file.
 *
 * Use this to indicate "I care about content starting NOW". Any previously recorded
 * but uncommitted content will be discarded.
 *
 * On Android, this uses a seamless recorder swap to prevent content loss at the start
 * of the new chunk.
 *
 * @platform iOS, Android
 * @param chunkId Optional identifier for this chunk. Use this to guarantee correct
 *   retrieval when finalizeChunk() is called. Recommended for interview/questionnaire
 *   flows where you need to associate recordings with specific questions.
 * @returns Elapsed time in milliseconds for the mark operation to complete
 * @example
 * ```typescript
 * startGlobalRecording({ onRecordingError: console.error });
 * // User navigates around (content is recorded but uncommitted)
 * const elapsedMs = await markChunkStart('question-5'); // "I care about content starting NOW for question 5"
 * console.log(`Mark completed in ${elapsedMs}ms`);
 * // User does something important...
 * const chunk = await finalizeChunk(); // Get the chunk for question 5
 * ```
 */
async function markChunkStart(chunkId) {
  return NitroScreenRecorderHybridObject.markChunkStart(chunkId);
}

/**
 * Discards any content recorded since the last markChunkStart() or finalizeChunk() call,
 * and begins recording to a fresh file. This is an alias for markChunkStart().
 *
 * Use this when you want to throw away recorded content without saving it.
 *
 * @platform iOS, Android
 * @param chunkId Optional identifier for the new chunk
 * @returns Elapsed time in milliseconds for the flush operation to complete
 * @example
 * ```typescript
 * await markChunkStart('q1'); // Start tracking
 * // User does something...
 * await flushChunk('q1'); // Oops, discard that, start fresh
 * // User does something else...
 * const chunk = await finalizeChunk(); // Save this instead
 * ```
 */
async function flushChunk(chunkId) {
  return NitroScreenRecorderHybridObject.markChunkStart(chunkId);
}

/**
 * Finalizes the current recording chunk and returns it.
 *
 * Returns the video file containing content from the last markChunkStart() until now.
 *
 * **iOS behavior:** Recording continues in a new file after this call (uninterrupted).
 * **Android behavior:** Recording pauses after this call. Call markChunkStart() to resume.
 *
 * @platform iOS, Android
 * @param options.settledTimeMs A "delay" time to wait before retrieving the file. Default = 500ms
 * @returns Promise resolving to the finalized chunk file
 * @example
 * ```typescript
 * markChunkStart();
 * // ... user does something important ...
 * const chunk1 = await finalizeChunk();
 * await uploadToServer(chunk1);
 *
 * // On Android, call markChunkStart() again to start next chunk
 * // On iOS, recording continues automatically
 * markChunkStart();
 * const chunk2 = await finalizeChunk();
 * await uploadToServer(chunk2);
 * ```
 */
async function finalizeChunk(options) {
  let settledTimeMs = 500;
  if (options?.settledTimeMs) {
    if (typeof options.settledTimeMs !== 'number' || options.settledTimeMs <= 0) {
      console.warn('Provided invalid value to `settledTimeMs` in `finalizeChunk` function, value will be ignored. Please use a value >0');
    } else {
      settledTimeMs = options.settledTimeMs;
    }
  }
  return NitroScreenRecorderHybridObject.finalizeChunk(settledTimeMs);
}

/**
 * Retrieves the most recently completed global recording file.
 * Returns undefined if no global recording has been completed.
 *
 * @platform iOS, Android
 * @returns The last global recording file or undefined if none exists
 * @deprecated Use retrieveGlobalRecording() instead for better chunk ID support
 * @example
 * ```typescript
 * const lastRecording = retrieveLastGlobalRecording();
 * if (lastRecording) {
 *   console.log('Duration:', lastRecording.duration);
 *   console.log('File size:', lastRecording.size);
 * }
 * ```
 */
function retrieveLastGlobalRecording() {
  return NitroScreenRecorderHybridObject.retrieveLastGlobalRecording();
}

/**
 * Retrieves a global recording file by its chunk ID, or the most recent one if no ID specified.
 * Returns undefined if the specified chunk is not found or no recordings exist.
 *
 * When a chunkId is provided, this function will find and return only the recording
 * that was created with that specific ID via markChunkStart(chunkId). This prevents
 * accidentally retrieving the wrong recording in race conditions.
 *
 * @platform iOS, Android
 * @param chunkId Optional chunk identifier. If provided, retrieves that specific chunk.
 *   If undefined, retrieves the most recent chunk (LIFO order).
 * @returns The matching recording file or undefined if not found
 * @example
 * ```typescript
 * // Retrieve by specific ID (recommended for interviews)
 * markChunkStart('question-5');
 * // ... user answers ...
 * const chunk = await finalizeChunk();
 * // Or manually retrieve:
 * const recording = retrieveGlobalRecording('question-5');
 *
 * // Retrieve most recent (LIFO fallback)
 * const lastRecording = retrieveGlobalRecording();
 * ```
 */
function retrieveGlobalRecording(chunkId) {
  return NitroScreenRecorderHybridObject.retrieveGlobalRecording(chunkId);
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

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
function addScreenRecordingListener({
  listener,
  ignoreRecordingsInitiatedElsewhere = false
}) {
  let listenerId;
  listenerId = NitroScreenRecorderHybridObject.addScreenRecordingListener(ignoreRecordingsInitiatedElsewhere, listener);
  return () => {
    NitroScreenRecorderHybridObject.removeScreenRecordingListener(listenerId);
  };
}

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
function addBroadcastPickerListener(listener) {
  if (_reactNative.Platform.OS === 'android') {
    // return a no-op cleanup function
    return () => {};
  }
  let listenerId;
  listenerId = NitroScreenRecorderHybridObject.addBroadcastPickerListener(listener);
  return () => {
    NitroScreenRecorderHybridObject.removeBroadcastPickerListener(listenerId);
  };
}

// ============================================================================
// EXTENSION STATUS
// ============================================================================

/**
 * Gets the current status of the broadcast extension.
 * Returns mic status, chunk status, and chunk start time.
 * Note: `state` is derived in the useGlobalRecording hook using isRecording.
 *
 * @platform iOS-only
 * @returns RawExtensionStatus with isMicrophoneEnabled, isCapturingChunk, and chunkStartedAt
 * @example
 * ```typescript
 * const status = getExtensionStatus();
 * console.log('Mic enabled:', status.isMicrophoneEnabled);
 * console.log('Capturing chunk:', status.isCapturingChunk);
 * ```
 */
function getExtensionStatus() {
  return NitroScreenRecorderHybridObject.getExtensionStatus();
}

/**
 * Returns whether the screen is currently being recorded.
 * Uses UIScreen.main.isCaptured on iOS which is instant and reliable.
 *
 * @platform iOS, Android
 * @returns true if screen is being recorded, false otherwise
 * @example
 * ```typescript
 * const isRecording = isScreenBeingRecorded();
 * if (isRecording) {
 *   console.log('Screen is being recorded!');
 * }
 * ```
 */
function isScreenBeingRecorded() {
  if (_reactNative.Platform.OS === 'android') {
    // Android doesn't have a direct equivalent, return false
    // The event listener is the reliable source on Android
    return false;
  }
  return NitroScreenRecorderHybridObject.isScreenBeingRecorded();
}

// ============================================================================
// EXTENSION LOGS (iOS only - for debugging broadcast extension)
// ============================================================================

/**
 * Returns logs from the broadcast extension for debugging.
 * The extension logs key events like chunk creation, writer operations, and errors.
 * Logs are stored in a ring buffer (max 200 entries) in UserDefaults.
 *
 * @platform iOS-only
 * @returns Array of log strings in format "[LEVEL] timestamp: message"
 * @example
 * ```typescript
 * const logs = getExtensionLogs();
 * logs.forEach(log => console.log(log));
 * // Output: "[INFO] 2024-01-15T10:30:00.123Z: handleFinalizeChunk: Writer finished successfully"
 * ```
 */
function getExtensionLogs() {
  if (_reactNative.Platform.OS === 'android') {
    return ['Extension logs are only available on iOS'];
  }
  return NitroScreenRecorderHybridObject.getExtensionLogs();
}

/**
 * Clears all extension logs from UserDefaults.
 * Call this before starting a recording session to get clean logs.
 *
 * @platform iOS-only
 * @example
 * ```typescript
 * clearExtensionLogs();
 * startGlobalRecording({ onRecordingError: console.error });
 * // ... recording ...
 * const logs = getExtensionLogs(); // Fresh logs from this session only
 * ```
 */
function clearExtensionLogs() {
  if (_reactNative.Platform.OS === 'android') {
    return;
  }
  return NitroScreenRecorderHybridObject.clearExtensionLogs();
}

/**
 * Returns audio metrics from the broadcast extension as JSON for Sentry integration.
 * Includes detailed metrics about audio capture: sample counts, durations,
 * backpressure events, sync deltas, and drop counts by reason.
 *
 * Use this to attach to Sentry events when audio issues are detected.
 *
 * @platform iOS-only
 * @returns JSON string containing audio metrics (parse with JSON.parse)
 * @example
 * ```typescript
 * const metricsJson = getExtensionAudioMetrics();
 * const metrics = JSON.parse(metricsJson);
 * if (metrics.metrics?.length > 0) {
 *   const lastMetrics = metrics.metrics[metrics.metrics.length - 1];
 *   Sentry.addBreadcrumb({
 *     category: 'audio',
 *     data: lastMetrics,
 *   });
 * }
 * ```
 */
function getExtensionAudioMetrics() {
  if (_reactNative.Platform.OS === 'android') {
    return '{"metrics": [], "platform": "android"}';
  }
  return NitroScreenRecorderHybridObject.getExtensionAudioMetrics();
}

/**
 * Clears audio metrics from UserDefaults.
 * Call this before starting a new recording session to get fresh metrics.
 *
 * @platform iOS-only
 * @example
 * ```typescript
 * clearExtensionAudioMetrics();
 * startGlobalRecording({ options: { enableMic: true } });
 * // ... recording ...
 * const metrics = getExtensionAudioMetrics(); // Fresh metrics from this session
 * ```
 */
function clearExtensionAudioMetrics() {
  if (_reactNative.Platform.OS === 'android') {
    return;
  }
  return NitroScreenRecorderHybridObject.clearExtensionAudioMetrics();
}

// ============================================================================
// UTILITIES
// ============================================================================

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
function clearCache() {
  return NitroScreenRecorderHybridObject.clearRecordingCache();
}
//# sourceMappingURL=functions.js.map