import type { ConfigProps } from '../@types';

export const IPHONEOS_DEPLOYMENT_TARGET = '11.0';
export const TARGETED_DEVICE_FAMILY = `"1,2"`;

export const getBroadcastExtensionTargetName = (props: ConfigProps) => {
  if (props.iosBroadcastExtensionTargetName)
    return props.iosBroadcastExtensionTargetName;
  return `BroadcastExtension`;
};

// Podfile configuration for ReplayKit (if needed for dependencies)
export const getBroadcastExtensionPodfileSnippet = (props: ConfigProps) => {
  const targetName = getBroadcastExtensionTargetName(props);
  return `
  target '${targetName}' do
    # ReplayKit is a system framework, no pods needed typically
    # Add any specific pods for broadcast extension here if needed
  end`;
};

// Template replacement patterns
export const GROUP_IDENTIFIER_TEMPLATE_REGEX = /{{GROUP_IDENTIFIER}}/gm;
export const BUNDLE_SHORT_VERSION_TEMPLATE_REGEX = /{{BUNDLE_SHORT_VERSION}}/gm;
export const BUNDLE_VERSION_TEMPLATE_REGEX = /{{BUNDLE_VERSION}}/gm;
export const SCHEME_TEMPLATE_REGEX = /{{SCHEME}}/gm;

export const DEFAULT_BUNDLE_VERSION = '1';
export const DEFAULT_BUNDLE_SHORT_VERSION = '1.0';

// Broadcast Extension specific constants
export const BROADCAST_EXT_SOURCE_FILES = [
  'SampleHandler.swift',
  'BroadcastWriter.swift',
  'BroadcastHelper.m',
];

export const BROADCAST_EXT_CONFIG_FILES = [
  `BroadcastExtension-Info.plist`,
  `BroadcastExtension.entitlements`,
  'BroadcastExtension-PrivacyInfo.xcprivacy',
  'BroadcastHelper.h',
  'BroadcastExtension-Bridging-Header.h',
];

// All extension files combined
export const BROADCAST_EXT_ALL_FILES = [
  ...BROADCAST_EXT_SOURCE_FILES,
  ...BROADCAST_EXT_CONFIG_FILES,
];

export const getAppGroup = (mainAppBundleId: string, props: ConfigProps) => {
  if (props.iosAppGroupIdentifier) return props.iosAppGroupIdentifier;
  return `group.${mainAppBundleId}.screen-recorder`;
};

// Helper function to get broadcast extension bundle identifier
export function getBroadcastExtensionBundleIdentifier(
  mainAppBundleId: string,
  props: ConfigProps
): string {
  if (props.iosExtensionBundleIdentifier)
    return props.iosExtensionBundleIdentifier;
  const targetName = getBroadcastExtensionTargetName(props);
  return `${mainAppBundleId}.${targetName}`;
}
