"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAppGroup = exports.BROADCAST_EXT_ALL_FILES = exports.BROADCAST_EXT_CONFIG_FILES = exports.BROADCAST_EXT_SOURCE_FILES = exports.DEFAULT_BUNDLE_SHORT_VERSION = exports.DEFAULT_BUNDLE_VERSION = exports.SCHEME_TEMPLATE_REGEX = exports.BUNDLE_VERSION_TEMPLATE_REGEX = exports.BUNDLE_SHORT_VERSION_TEMPLATE_REGEX = exports.GROUP_IDENTIFIER_TEMPLATE_REGEX = exports.getBroadcastExtensionPodfileSnippet = exports.getBroadcastExtensionTargetName = exports.TARGETED_DEVICE_FAMILY = exports.IPHONEOS_DEPLOYMENT_TARGET = void 0;
exports.getBroadcastExtensionBundleIdentifier = getBroadcastExtensionBundleIdentifier;
exports.IPHONEOS_DEPLOYMENT_TARGET = '11.0';
exports.TARGETED_DEVICE_FAMILY = `"1,2"`;
const getBroadcastExtensionTargetName = (props) => {
    if (props.iosBroadcastExtensionTargetName)
        return props.iosBroadcastExtensionTargetName;
    return `BroadcastExtension`;
};
exports.getBroadcastExtensionTargetName = getBroadcastExtensionTargetName;
// Podfile configuration for ReplayKit (if needed for dependencies)
const getBroadcastExtensionPodfileSnippet = (props) => {
    const targetName = (0, exports.getBroadcastExtensionTargetName)(props);
    return `
  target '${targetName}' do
    # ReplayKit is a system framework, no pods needed typically
    # Add any specific pods for broadcast extension here if needed
  end`;
};
exports.getBroadcastExtensionPodfileSnippet = getBroadcastExtensionPodfileSnippet;
// Template replacement patterns
exports.GROUP_IDENTIFIER_TEMPLATE_REGEX = /{{GROUP_IDENTIFIER}}/gm;
exports.BUNDLE_SHORT_VERSION_TEMPLATE_REGEX = /{{BUNDLE_SHORT_VERSION}}/gm;
exports.BUNDLE_VERSION_TEMPLATE_REGEX = /{{BUNDLE_VERSION}}/gm;
exports.SCHEME_TEMPLATE_REGEX = /{{SCHEME}}/gm;
exports.DEFAULT_BUNDLE_VERSION = '1';
exports.DEFAULT_BUNDLE_SHORT_VERSION = '1.0';
// Broadcast Extension specific constants
exports.BROADCAST_EXT_SOURCE_FILES = [
    'SampleHandler.swift',
    'BroadcastWriter.swift',
    'BroadcastHelper.m',
];
exports.BROADCAST_EXT_CONFIG_FILES = [
    `BroadcastExtension-Info.plist`,
    `BroadcastExtension.entitlements`,
    'BroadcastExtension-PrivacyInfo.xcprivacy',
    'BroadcastHelper.h',
    'BroadcastExtension-Bridging-Header.h',
];
// All extension files combined
exports.BROADCAST_EXT_ALL_FILES = [
    ...exports.BROADCAST_EXT_SOURCE_FILES,
    ...exports.BROADCAST_EXT_CONFIG_FILES,
];
const getAppGroup = (mainAppBundleId, props) => {
    if (props.iosAppGroupIdentifier)
        return props.iosAppGroupIdentifier;
    return `group.${mainAppBundleId}.screen-recorder`;
};
exports.getAppGroup = getAppGroup;
// Helper function to get broadcast extension bundle identifier
function getBroadcastExtensionBundleIdentifier(mainAppBundleId, props) {
    if (props.iosExtensionBundleIdentifier)
        return props.iosExtensionBundleIdentifier;
    const targetName = (0, exports.getBroadcastExtensionTargetName)(props);
    return `${mainAppBundleId}.${targetName}`;
}
