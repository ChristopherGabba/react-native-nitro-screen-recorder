import { type ConfigPlugin } from '@expo/config-plugins';
import { type ConfigProps } from '../@types';
/**
 * Copies the ReplayKit Broadcast Upload Extension templates into the iOS
 * project and patches them so their App Group + bundle versions match the
 * host app. Mirrors OneSignal's NSE flow for consistency.
 */
export declare const withBroadcastExtensionFiles: ConfigPlugin<ConfigProps>;
