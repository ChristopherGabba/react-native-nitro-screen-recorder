"use strict";

import { useState, useEffect } from 'react';
import { addBroadcastPickerListener, addScreenRecordingListener, retrieveLastGlobalRecording } from '../functions';
/**
 * A "modern" sleep statement.
 *
 * @param ms The number of milliseconds to wait.
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Configuration options for the global recording hook.
 */

/**
 * Return value from the global recording hook.
 */

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
 *     onBroadcastModalShown: () => {
 *       console.log("User tried to initiate recording")
 *     },
 *     onBroadcastModalDismissed: () => {
 *       redirectToAnotherApp()
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
export const useGlobalRecording = props => {
  const [isRecording, setIsRecording] = useState(false);
  useEffect(() => {
    const unsubscribe = addScreenRecordingListener({
      ignoreRecordingsInitiatedElsewhere: props?.ignoreRecordingsInitiatedElsewhere ?? false,
      listener: async event => {
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
      }
    });
    return unsubscribe;
  }, [props]);
  useEffect(() => {
    const unsubscribe = addBroadcastPickerListener(event => {
      event === 'dismissed' ? props?.onBroadcastModalDismissed?.() : props?.onBroadcastModalShown?.();
    });
    return unsubscribe;
  }, [props]);
  return {
    isRecording
  };
};
//# sourceMappingURL=useGlobalRecording.js.map