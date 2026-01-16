import {
  withPlugins,
  createRunOncePlugin,
  AndroidConfig,
} from '@expo/config-plugins';
import type { ConfigPlugin } from '@expo/config-plugins';
import type { ConfigProps } from './@types';
import { withBroadcastExtension } from './ios/withBroadcastExtension';
import { withAndroidScreenRecording } from './android/withAndroidScreenRecording';
import { validatePluginProps } from './support/validatePluginProps';

const pkg = require('../package.json');

const CAMERA_USAGE = 'Allow $(PRODUCT_NAME) to access your camera';
const MICROPHONE_USAGE = 'Allow $(PRODUCT_NAME) to access your microphone';

const withScreenRecorder: ConfigPlugin<ConfigProps> = (config, props = {}) => {
  validatePluginProps(props);

  /*---------------IOS-------------------- */
  if (config.ios == null) config.ios = {};
  if (config.ios.infoPlist == null) config.ios.infoPlist = {};

  if (props.enableCameraPermission === true) {
    config.ios.infoPlist.NSCameraUsageDescription =
      props.cameraPermissionText ??
      (config.ios.infoPlist.NSCameraUsageDescription as string | undefined) ??
      CAMERA_USAGE;
  }

  if (props.enableMicrophonePermission === true) {
    config.ios.infoPlist.NSMicrophoneUsageDescription =
      props.microphonePermissionText ??
      (config.ios.infoPlist.NSMicrophoneUsageDescription as
        | string
        | undefined) ??
      MICROPHONE_USAGE;
  }

  config = withBroadcastExtension(config, props);

  /*---------------ANDROID-------------------- */
  const androidPermissions: string[] = [
    // already conditionally added
    ...(props.enableMicrophonePermission !== false
      ? ['android.permission.RECORD_AUDIO']
      : []),
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
    'android.permission.FOREGROUND_SERVICE_MICROPHONE',
    'android.permission.POST_NOTIFICATIONS',
  ];

  return withPlugins(config, [
    // Android plugins
    [AndroidConfig.Permissions.withPermissions, androidPermissions],
    [withAndroidScreenRecording, props],
  ]);
};

export default createRunOncePlugin(withScreenRecorder, pkg.name, pkg.version);
