"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_plugins_1 = require("@expo/config-plugins");
const withBroadcastExtension_1 = require("./ios/withBroadcastExtension");
const withAndroidScreenRecording_1 = require("./android/withAndroidScreenRecording");
const validatePluginProps_1 = require("./support/validatePluginProps");
const pkg = require('../package.json');
const CAMERA_USAGE = 'Allow $(PRODUCT_NAME) to access your camera';
const MICROPHONE_USAGE = 'Allow $(PRODUCT_NAME) to access your microphone';
const withScreenRecorder = (config, props = {}) => {
    var _a, _b, _c, _d;
    (0, validatePluginProps_1.validatePluginProps)(props);
    /*---------------IOS-------------------- */
    if (config.ios == null)
        config.ios = {};
    if (config.ios.infoPlist == null)
        config.ios.infoPlist = {};
    if (props.enableCameraPermission === true) {
        config.ios.infoPlist.NSCameraUsageDescription =
            (_b = (_a = props.cameraPermissionText) !== null && _a !== void 0 ? _a : config.ios.infoPlist.NSCameraUsageDescription) !== null && _b !== void 0 ? _b : CAMERA_USAGE;
    }
    if (props.enableMicrophonePermission === true) {
        config.ios.infoPlist.NSMicrophoneUsageDescription =
            (_d = (_c = props.microphonePermissionText) !== null && _c !== void 0 ? _c : config.ios.infoPlist.NSMicrophoneUsageDescription) !== null && _d !== void 0 ? _d : MICROPHONE_USAGE;
    }
    config = (0, withBroadcastExtension_1.withBroadcastExtension)(config, props);
    /*---------------ANDROID-------------------- */
    const androidPermissions = [
        // already conditionally added
        ...(props.enableMicrophonePermission !== false
            ? ['android.permission.RECORD_AUDIO']
            : []),
        'android.permission.FOREGROUND_SERVICE',
        'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
        'android.permission.FOREGROUND_SERVICE_MICROPHONE',
        'android.permission.POST_NOTIFICATIONS',
    ];
    return (0, config_plugins_1.withPlugins)(config, [
        // Android plugins
        [config_plugins_1.AndroidConfig.Permissions.withPermissions, androidPermissions],
        [withAndroidScreenRecording_1.withAndroidScreenRecording, props],
    ]);
};
exports.default = (0, config_plugins_1.createRunOncePlugin)(withScreenRecorder, pkg.name, pkg.version);
