"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useCameraPermission = useCameraPermission;
exports.useMicrophonePermission = useMicrophonePermission;
var _react = require("react");
var _reactNative = require("react-native");
var _functions = require("../functions");
function usePermission(get, request) {
  const [hasPermission, setHasPermission] = (0, _react.useState)(() => get() === 'granted');
  const requestPermission = (0, _react.useCallback)(async () => {
    const result = await request();
    const hasPermissionNow = result.status === 'granted';
    setHasPermission(hasPermissionNow);
    return hasPermissionNow;
  }, [request]);
  (0, _react.useEffect)(() => {
    // Refresh permission when app state changes, as user might have allowed it in Settings
    const listener = _reactNative.AppState.addEventListener('change', () => {
      setHasPermission(get() === 'granted');
    });
    return () => listener.remove();
  }, [get]);
  return (0, _react.useMemo)(() => ({
    hasPermission,
    requestPermission
  }), [hasPermission, requestPermission]);
}

/**
 * Returns whether the user has granted permission to use the Camera, or not.
 *
 * If the user doesn't grant Camera Permission, you cannot use the `<Camera>`.
 *
 * @example
 * ```tsx
 * const { hasPermission, requestPermission } = useCameraPermission()
 *
 * if (!hasPermission) {
 *   return <PermissionScreen onPress={requestPermission} />
 * } else {
 *   return <Camera ... />
 * }
 * ```
 */
function useCameraPermission() {
  return usePermission(_functions.getCameraPermissionStatus, _functions.requestCameraPermission);
}

/**
 * Returns whether the user has granted permission to use the Microphone, or not.
 *
 * If the user doesn't grant Audio Permission, you can use the `<Camera>` but you cannot
 * record videos with audio (the `audio={..}` prop).
 *
 * @example
 * ```tsx
 * const { hasPermission, requestPermission } = useMicrophonePermission()
 * const canRecordAudio = hasPermission
 *
 * return <Camera video={true} audio={canRecordAudio} />
 * ```
 */
function useMicrophonePermission() {
  return usePermission(_functions.getMicrophonePermissionStatus, _functions.requestMicrophonePermission);
}
//# sourceMappingURL=useCameraMicPermissions.js.map