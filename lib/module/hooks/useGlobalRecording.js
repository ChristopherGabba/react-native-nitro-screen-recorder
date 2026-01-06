"use strict";

import { useState, useEffect, useRef } from 'react';
import { addBroadcastPickerListener, addScreenRecordingListener, retrieveLastGlobalRecording, getExtensionStatus, isScreenBeingRecorded } from '../functions';
/**
 * A "modern" sleep statement.
 *
 * @param ms The number of milliseconds to wait.
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Default extension status when idle.
 */
const IDLE_STATUS = {
  state: 'idle',
  isMicrophoneEnabled: false,
  isCapturingChunk: false,
  chunkStartedAt: 0
};

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
export const useGlobalRecording = props => {
  const [isRecording, setIsRecording] = useState(false);
  const [extensionStatus, setExtensionStatus] = useState(IDLE_STATUS);

  // Track previous recording state to detect transitions
  const wasRecordingRef = useRef(false);

  // Screen recording listener - primary source for callbacks
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

  // Broadcast picker listener
  useEffect(() => {
    const unsubscribe = addBroadcastPickerListener(event => {
      if (event === 'dismissed') {
        props?.onBroadcastModalDismissed?.();
      } else {
        props?.onBroadcastModalShown?.();
      }
    });
    return unsubscribe;
  }, [props]);

  // Polling for isRecording (using isCaptured) and extensionStatus
  useEffect(() => {
    const pollingInterval = props?.pollingIntervalMs ?? 200;
    const pollStatus = () => {
      // Use isCaptured for reliable isRecording detection
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

      // Derive state from isRecording (reliable)
      const state = !currentlyRecording ? 'idle' : rawStatus.isCapturingChunk ? 'capturingChunk' : 'running';
      setExtensionStatus({
        ...rawStatus,
        state
      });
    };
    pollStatus(); // Poll immediately on mount
    const interval = setInterval(pollStatus, pollingInterval);
    return () => clearInterval(interval);
  }, [props?.pollingIntervalMs]);
  return {
    isRecording,
    extensionStatus
  };
};
//# sourceMappingURL=useGlobalRecording.js.map