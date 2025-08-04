import { useState, useEffect } from 'react';
import {
  addScreenRecordingListener,
  retrieveLastGlobalRecording,
} from '../functions';
import { ScreenRecordingFile } from '../types';

/**
 * A "modern" sleep statement.
 *
 * @param ms The number of milliseconds to wait.
 */
const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve as () => void, ms));

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
   * Time in milliseconds to wait after recording ends before attempting to retrieve the file.
   * This allows the system time to finish writing the recording to disk.
   *
   * @default 500
   */
  settledTimeMs?: number;
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
 *   const { isRecording } = useGlobalRecording({
 *     onRecordingStarted: () => {
 *       analytics.track('recording_started');
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

  useEffect(() => {
    const unsubscribe = addScreenRecordingListener(async (event) => {
      if (event.type === 'withinApp') return;

      if (event.reason === 'began') {
        setIsRecording(true);
        props?.onRecordingStarted?.();
      } else {
        setIsRecording(false);
        // We add a small delay after the recording ends to allow the file to finish writing
        // to disk before trying to fetch it
        delay(props?.settledTimeMs ?? 500);
        const file = retrieveLastGlobalRecording();
        props?.onRecordingFinished?.(file);
      }
    });

    return unsubscribe;
  }, [props]);

  return { isRecording };
};
