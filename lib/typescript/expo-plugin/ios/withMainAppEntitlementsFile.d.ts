import { type ConfigPlugin } from '@expo/config-plugins';
import { type ConfigProps } from '../@types';
/**
 * Add the main app's entitlements file to the Xcode project navigator
 * This ensures the .entitlements file is visible in Xcode's file tree
 */
export declare const withMainAppEntitlementsFile: ConfigPlugin<ConfigProps>;
