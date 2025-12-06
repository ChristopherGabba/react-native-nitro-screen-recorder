"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const FileManager_1 = require("./FileManager");
const iosConstants_1 = require("./iosConstants");
// project `ios/${BROADCAST_EXT_TARGET_NAME}` directory
const entitlementsFileName = `BroadcastExtension.entitlements`;
const plistFileName = `BroadcastExtension-Info.plist`;
class BEUpdaterManager {
    constructor(iosPath, props) {
        this.extensionPath = '';
        const targetName = (0, iosConstants_1.getBroadcastExtensionTargetName)(props);
        this.extensionPath = `${iosPath}/${targetName}`;
    }
    /**
     * Injects the real App Group identifier into the entitlements file so the
     * Broadcast Upload Extension can share storage with the main app.
     */
    async updateEntitlements(groupIdentifier) {
        const entitlementsFilePath = `${this.extensionPath}/${entitlementsFileName}`;
        let entitlementsFile = await FileManager_1.FileManager.readFile(entitlementsFilePath);
        entitlementsFile = entitlementsFile.replace(iosConstants_1.GROUP_IDENTIFIER_TEMPLATE_REGEX, groupIdentifier);
        await FileManager_1.FileManager.writeFile(entitlementsFilePath, entitlementsFile);
    }
    /**
     * Makes CFBundleVersion of the Broadcast Extension match the host app’s
     * build number to avoid App Store validation errors.
     */
    async updateInfoPlist(version, groupIdentifier) {
        const plistFilePath = `${this.extensionPath}/${plistFileName}`;
        let plistFile = await FileManager_1.FileManager.readFile(plistFilePath);
        plistFile = plistFile
            .replace(iosConstants_1.BUNDLE_VERSION_TEMPLATE_REGEX, version)
            .replace(iosConstants_1.GROUP_IDENTIFIER_TEMPLATE_REGEX, groupIdentifier);
        await FileManager_1.FileManager.writeFile(plistFilePath, plistFile);
    }
    /**
     * Syncs CFBundleShortVersionString (marketing version) with the main app so
     * TestFlight/App Store show a single coherent version.
     */
    async updateBundleShortVersion(version) {
        const plistFilePath = `${this.extensionPath}/${plistFileName}`;
        let plistFile = await FileManager_1.FileManager.readFile(plistFilePath);
        plistFile = plistFile.replace(iosConstants_1.BUNDLE_SHORT_VERSION_TEMPLATE_REGEX, version);
        await FileManager_1.FileManager.writeFile(plistFilePath, plistFile);
    }
}
exports.default = BEUpdaterManager;
