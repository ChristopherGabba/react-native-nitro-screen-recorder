"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.withBroadcastExtensionXcodeProject = void 0;
const config_plugins_1 = require("@expo/config-plugins");
const iosConstants_1 = require("../support/iosConstants");
const ScreenRecorderLog_1 = require("../support/ScreenRecorderLog");
const assert_1 = __importDefault(require("assert"));
//───────────────────────────────────────────────────────────────────────────
// Helper: pull DEVELOPMENT_TEAM from the main-app target’s build settings
//───────────────────────────────────────────────────────────────────────────
function getMainAppDevelopmentTeam(pbx, l) {
    var _a, _b;
    const configs = pbx.pbxXCBuildConfigurationSection();
    for (const key in configs) {
        const config = configs[key];
        const bs = config.buildSettings;
        if (!bs || !bs.PRODUCT_NAME)
            continue;
        const productName = (_a = bs.PRODUCT_NAME) === null || _a === void 0 ? void 0 : _a.replace(/"/g, '');
        // Ignore other extensions/widgets
        if (productName &&
            (productName.includes('Extension') || productName.includes('Widget'))) {
            continue;
        }
        const developmentTeam = (_b = bs.DEVELOPMENT_TEAM) === null || _b === void 0 ? void 0 : _b.replace(/"/g, '');
        if (developmentTeam) {
            l.log(`Found DEVELOPMENT_TEAM='${developmentTeam}' from main app configuration.`);
            return developmentTeam;
        }
    }
    l.error('No DEVELOPMENT_TEAM found in main app build settings. Developer will need to manually add Dev Team.');
    return null;
}
//───────────────────────────────────────────────────────────────────────────
// Main Expo config-plugin
//───────────────────────────────────────────────────────────────────────────
const withBroadcastExtensionXcodeProject = (config, props) => {
    return (0, config_plugins_1.withXcodeProject)(config, (newConfig) => {
        var _a, _b, _c, _d;
        const xcodeProject = newConfig.modResults;
        const extensionTargetName = (0, iosConstants_1.getBroadcastExtensionTargetName)(props);
        const appIdentifier = (_a = newConfig.ios) === null || _a === void 0 ? void 0 : _a.bundleIdentifier;
        (0, assert_1.default)(appIdentifier, "Missing 'ios.bundleIdentifier' in app config");
        const bundleIdentifier = (0, iosConstants_1.getBroadcastExtensionBundleIdentifier)(appIdentifier, props);
        /* ------------------------------------------------------------------ */
        /* 0. Resolve DEVELOPMENT_TEAM (props override > auto-detect > none)  */
        /* ------------------------------------------------------------------ */
        const detectedDevTeam = getMainAppDevelopmentTeam(xcodeProject, ScreenRecorderLog_1.ScreenRecorderLog);
        const devTeam = detectedDevTeam !== null && detectedDevTeam !== void 0 ? detectedDevTeam : undefined;
        /* ------------------------------------------------------------------ */
        /* 1. Bail out early if target/group already exist                    */
        /* ------------------------------------------------------------------ */
        const existingTarget = xcodeProject.pbxTargetByName(extensionTargetName);
        if (existingTarget) {
            ScreenRecorderLog_1.ScreenRecorderLog.log(`${extensionTargetName} already exists in project. Skipping…`);
            return newConfig;
        }
        const existingGroups = xcodeProject.hash.project.objects.PBXGroup;
        const groupExists = Object.values(existingGroups).some((group) => group && group.name === extensionTargetName);
        if (groupExists) {
            ScreenRecorderLog_1.ScreenRecorderLog.log(`${extensionTargetName} group already exists in project. Skipping…`);
            return newConfig;
        }
        /* ------------------------------------------------------------------ */
        /* 2. Create target, group & build phases (COMBINED APPROACH)        */
        /* ------------------------------------------------------------------ */
        const pbx = xcodeProject;
        // 2.1 Create PBXGroup for the extension (OneSignal style - single group creation)
        const extGroup = pbx.addPbxGroup(iosConstants_1.BROADCAST_EXT_ALL_FILES, extensionTargetName, extensionTargetName);
        // 2.2 Add the new PBXGroup to the top level group
        const groups = pbx.hash.project.objects.PBXGroup;
        Object.keys(groups).forEach(function (key) {
            if (typeof groups[key] === 'object' &&
                groups[key].name === undefined &&
                groups[key].path === undefined) {
                pbx.addToPbxGroup(extGroup.uuid, key);
            }
        });
        // 2.3 WORK AROUND for addTarget BUG (from OneSignal)
        // Xcode projects don't contain these if there is only one target
        const projObjects = pbx.hash.project.objects;
        projObjects.PBXTargetDependency = projObjects.PBXTargetDependency || {};
        projObjects.PBXContainerItemProxy = projObjects.PBXContainerItemProxy || {};
        // 2.4 Create native target
        const target = pbx.addTarget(extensionTargetName, 'app_extension', extensionTargetName);
        // 2.5 Add build phases to the new target (OneSignal approach)
        pbx.addBuildPhase(iosConstants_1.BROADCAST_EXT_SOURCE_FILES, // Add source files directly to the build phase
        'PBXSourcesBuildPhase', 'Sources', target.uuid);
        pbx.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
        pbx.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
        // 2.6 Link ReplayKit
        pbx.addFramework('ReplayKit.framework', {
            target: target.uuid,
            sourceTree: 'SDKROOT',
            link: true,
        });
        /* ------------------------------------------------------------------ */
        /* 3. Build-settings tweaks                                           */
        /* ------------------------------------------------------------------ */
        const configurations = xcodeProject.pbxXCBuildConfigurationSection();
        for (const key in configurations) {
            const cfg = configurations[key];
            const b = cfg.buildSettings;
            if (!b)
                continue;
            if (b.PRODUCT_NAME === `"${extensionTargetName}"`) {
                b.CLANG_ENABLE_MODULES = 'YES';
                b.INFOPLIST_FILE = `"${extensionTargetName}/BroadcastExtension-Info.plist"`;
                b.CODE_SIGN_ENTITLEMENTS = `"${extensionTargetName}/BroadcastExtension.entitlements"`;
                b.CODE_SIGN_STYLE = 'Automatic';
                b.CURRENT_PROJECT_VERSION =
                    (_c = (_b = newConfig.ios) === null || _b === void 0 ? void 0 : _b.buildNumber) !== null && _c !== void 0 ? _c : iosConstants_1.DEFAULT_BUNDLE_VERSION;
                b.MARKETING_VERSION = (_d = newConfig.version) !== null && _d !== void 0 ? _d : iosConstants_1.DEFAULT_BUNDLE_SHORT_VERSION;
                b.PRODUCT_BUNDLE_IDENTIFIER = `"${bundleIdentifier}"`;
                b.SWIFT_VERSION = '5.0';
                b.SWIFT_EMIT_LOC_STRINGS = 'YES';
                b.SWIFT_OBJC_BRIDGING_HEADER = `"${extensionTargetName}/BroadcastExtension-Bridging-Header.h"`;
                b.HEADER_SEARCH_PATHS = `"$(SRCROOT)/${extensionTargetName}"`;
                b.TARGETED_DEVICE_FAMILY = iosConstants_1.TARGETED_DEVICE_FAMILY;
                if (devTeam)
                    b.DEVELOPMENT_TEAM = devTeam;
            }
        }
        /* ------------------------------------------------------------------ */
        /* 4. Apply DevelopmentTeam to both targets                           */
        /* ------------------------------------------------------------------ */
        if (devTeam) {
            xcodeProject.addTargetAttribute('DevelopmentTeam', devTeam);
            const broadcastTarget = xcodeProject.pbxTargetByName(extensionTargetName);
            xcodeProject.addTargetAttribute('DevelopmentTeam', devTeam, broadcastTarget);
        }
        ScreenRecorderLog_1.ScreenRecorderLog.log(`Successfully created ${extensionTargetName} target with files`);
        return newConfig;
    });
};
exports.withBroadcastExtensionXcodeProject = withBroadcastExtensionXcodeProject;
