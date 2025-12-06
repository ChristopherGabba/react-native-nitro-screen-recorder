import { type ConfigProps } from '../@types';
export default class BEUpdaterManager {
    private extensionPath;
    constructor(iosPath: string, props: ConfigProps);
    /**
     * Injects the real App Group identifier into the entitlements file so the
     * Broadcast Upload Extension can share storage with the main app.
     */
    updateEntitlements(groupIdentifier: string): Promise<void>;
    /**
     * Makes CFBundleVersion of the Broadcast Extension match the host app’s
     * build number to avoid App Store validation errors.
     */
    updateInfoPlist(version: string, groupIdentifier: string): Promise<void>;
    /**
     * Syncs CFBundleShortVersionString (marketing version) with the main app so
     * TestFlight/App Store show a single coherent version.
     */
    updateBundleShortVersion(version: string): Promise<void>;
}
