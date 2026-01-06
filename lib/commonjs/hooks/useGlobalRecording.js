"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useGlobalRecording = void 0;
var _react = require("react");
var _functions = require("../functions");
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
  isBroadcasting: false,
  isExtensionRunning: false,
  isMicrophoneEnabled: false,
  isCapturingChunk: false,
  lastHeartbeat: 0,
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
const useGlobalRecording = props => {
  const [isRecording, setIsRecording] = (0, _react.useState)(false);
  const [extensionStatus, setExtensionStatus] = (0, _react.useState)(IDLE_STATUS);

  // Use ref to track if we should keep polling (avoids stale closure issues)
  const shouldPollRef = (0, _react.useRef)(false);

  // Screen recording listener
  (0, _react.useEffect)(() => {
    const unsubscribe = (0, _functions.addScreenRecordingListener)({
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
          const file = (0, _functions.retrieveLastGlobalRecording)();
          props?.onRecordingFinished?.(file);
        }
      }
    });
    return unsubscribe;
  }, [props]);

  // Broadcast picker listener
  (0, _react.useEffect)(() => {
    const unsubscribe = (0, _functions.addBroadcastPickerListener)(event => {
      if (event === 'dismissed') {
        props?.onBroadcastModalDismissed?.();
      } else {
        props?.onBroadcastModalShown?.();
      }
    });
    return unsubscribe;
  }, [props]);

  // Extension status polling - only poll while recording or extension is active
  (0, _react.useEffect)(() => {
    const shouldPoll = isRecording || extensionStatus.isExtensionRunning;
    shouldPollRef.current = shouldPoll;
    if (!shouldPoll) {
      // Reset to idle when nothing is happening
      if (extensionStatus.state !== 'idle') {
        setExtensionStatus(IDLE_STATUS);
      }
      return;
    }
    const pollingInterval = props?.pollingIntervalMs ?? 200;
    const pollStatus = () => {
      if (!shouldPollRef.current) return;
      const status = (0, _functions.getExtensionStatus)();
      setExtensionStatus(status);
    };
    pollStatus(); // Poll immediately
    const interval = setInterval(pollStatus, pollingInterval);
    return () => clearInterval(interval);
  }, [isRecording, extensionStatus.isExtensionRunning, extensionStatus.state, props?.pollingIntervalMs]);
  return {
    isRecording,
    extensionStatus
  };
};
exports.useGlobalRecording = useGlobalRecording;
//# sourceMappingURL=useGlobalRecording.js.map