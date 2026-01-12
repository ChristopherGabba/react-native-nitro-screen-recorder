import { useState, useEffect, useRef } from 'react';
import {
  addBroadcastPickerListener,
  addScreenRecordingListener,
  retrieveLastGlobalRecording,
  getExtensionStatus,
  isScreenBeingRecorded,
} from '../functions';
import type {
  ScreenRecordingFile,
  ExtensionStatus,
  ExtensionState,
} from '../types';

/**
 * A "modern" sleep statement.
 *
 * @param ms The number of milliseconds to wait.
 */
const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve as () => void, ms));

/**
 * Default extension status when idle.
 */
const IDLE_STATUS: ExtensionStatus = {
  state: 'idle',
  isMicrophoneEnabled: false,
  isCapturingChunk: false,
  chunkStartedAt: 0,
  captureMode: 'unknown',
};

/**
 * Configuration options for the global recording hook.
 */
type GlobalRecordingHookInput = {
  /**
   * Callback invoked when a global screen recording begins.
   * Use this to update your UI to indicate recording is in progress.
   */
  onRecordingStarted?: () => void;
  /**
   * Callback invoked when a global screen recording finishes.
   * Receives the recorded file (if successfully retrieved) or undefined if retrieval failed.
   *
   * @param file The screen recording file, or undefined if retrieval failed
   */
  onRecordingFinished?: (file?: ScreenRecordingFile) => void;
  /**
   * A callback for iOS when the broadcast modal shows, in case you want to
   * perform some analytics or tasks. Is a no-op on android.
   */
  onBroadcastModalShown?: () => void;
  /* A callback for iOS when the broadcast modal is dimissed, in case you want to
   * perform some analytics or tasks. Is a no-op on android.
   */
  onBroadcastModalDismissed?: () => void;
  /**
   * Time in milliseconds to wait after recording ends before attempting to retrieve the file.
   * This allows the system time to finish writing the recording to disk.
   *
   * @default 500
   */
  settledTimeMs?: number;
  /**
   * This property is passed to the underlying listener to ignore recordings that were initiated by the
   * external system. This is useful if you only want to track global recordings that were started via the startGlobalRecording function.
   */
  ignoreRecordingsInitiatedElsewhere?: boolean;
  /**
   * How often to poll the extension status in milliseconds.
   * @default 200
   */
  pollingIntervalMs?: number;
};

/**
 * Return value from the global recording hook.
 */
type GlobalRecordingHookOutput = {
  /**
   * Whether a global screen recording is currently active.
   * Updates automatically as recordings start and stop.
   */
  isRecording: boolean;
  /**
   * Current status of the broadcast extension (iOS only).
   * Includes detailed state like 'idle', 'starting', 'running', 'capturingChunk'.
   */
  extensionStatus: ExtensionStatus;
};

/**
 * React hook for monitoring and responding to global screen recording events.
 *
 * This hook automatically tracks the state of global screen recordings (recordings
 * that capture the entire device screen, not just your app) and provides callbacks
 * for when recordings start and finish. It also manages the timing of file retrieval
 * to ensure the recording file is fully written before attempting to access it.
 *
 * **Key Features:**
 * - Automatically tracks global recording state
 * - Provides lifecycle callbacks for recording start/finish events
 * - Handles timing delays for safe file retrieval
 * - Filters out within-app recordings (only responds to global recordings)
 *
 * **Use Cases:**
 * - Show recording indicators in your UI
 * - Automatically upload or process completed recordings
 * - Trigger analytics events for recording usage
 * - Update app state based on recording activity
 *
 * @param props Configuration options for the hook
 * @returns Object containing the current recording state
 *
 * @example
 * ```tsx
 *   const { isRecording, extensionStatus } = useGlobalRecording({
 *     onRecordingStarted: () => {
 *       analytics.track('recording_started');
 *     },
 *     onBroadcastModalShown: () => {
 *       console.log("User tried to initiate recording")
 *     },
 *     onBroadcastModalDismissed: () => {
 *       // Good place to show "Starting..." in your UI
 *     },
 *     onRecordingFinished: async (file) => {
 *       if (file) {
 *         try {
 *           await uploadRecording(file);
 *           showSuccessToast('Recording uploaded successfully!');
 *         } catch (error) {
 *           showErrorToast('Failed to upload recording');
 *         }
 *       }
 *     },
 *   });
 * ```
 */
export const useGlobalRecording = (
  props?: GlobalRecordingHookInput
): GlobalRecordingHookOutput => {
  const [isRecording, setIsRecording] = useState(false);
  const [extensionStatus, setExtensionStatus] =
    useState<ExtensionStatus>(IDLE_STATUS);

  // Track previous recording state to detect transitions
  const wasRecordingRef = useRef(false);

  // Screen recording listener - primary source for callbacks
  useEffect(() => {
    const unsubscribe = addScreenRecordingListener({
      ignoreRecordingsInitiatedElsewhere:
        props?.ignoreRecordingsInitiatedElsewhere ?? false,
      listener: async (event) => {
        if (event.type === 'withinApp') return;

        if (event.reason === 'began') {
          setIsRecording(true);
          props?.onRecordingStarted?.();
        } else {
          setIsRecording(false);
          // We add a small delay after the recording ends to allow the file to finish writing
          // to disk before trying to fetch it
          await delay(props?.settledTimeMs ?? 500);
          const file = retrieveLastGlobalRecording();
          props?.onRecordingFinished?.(file);
        }
      },
    });

    return unsubscribe;
  }, [props]);

  // Broadcast picker listener
  useEffect(() => {
    const unsubscribe = addBroadcastPickerListener((event) => {
      if (event === 'dismissed') {
        props?.onBroadcastModalDismissed?.();
      } else {
        props?.onBroadcastModalShown?.();
      }
    });

    return unsubscribe;
  }, [props]);

  // Use a ref to track the current isRecording state for use in polling
  const isRecordingRef = useRef(false);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // Polling for isRecording (using isCaptured) and extensionStatus
  useEffect(() => {
    const pollingInterval = props?.pollingIntervalMs ?? 200;

    const pollStatus = () => {
      // Use isCaptured for reliable isRecording detection (backup for hot reload)
      const currentlyRecording = isScreenBeingRecorded();

      // Detect transitions for app refresh case (when event listener missed the start)
      if (currentlyRecording && !wasRecordingRef.current) {
        setIsRecording(true);
      } else if (!currentlyRecording && wasRecordingRef.current) {
        setIsRecording(false);
      }
      wasRecordingRef.current = currentlyRecording;

      // Get extension status for detailed info (chunk status, mic, etc.)
      const rawStatus = getExtensionStatus();

      // Use isRecording state (from event listeners, which works reliably)
      // OR polling result as fallback - whichever says recording is active
      const isActive = isRecordingRef.current || currentlyRecording;

      const state: ExtensionState = !isActive
        ? 'idle'
        : rawStatus.isCapturingChunk
          ? 'capturingChunk'
          : 'running';

      setExtensionStatus({ ...rawStatus, state });
    };

    pollStatus(); // Poll immediately on mount
    const interval = setInterval(pollStatus, pollingInterval);

    return () => clearInterval(interval);
  }, [props?.pollingIntervalMs]);

  return { isRecording, extensionStatus };
};
