"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.withBroadcastExtensionFiles = void 0;
const config_plugins_1 = require("@expo/config-plugins");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const iosConstants_1 = require("../support/iosConstants");
const FileManager_1 = require("../support/FileManager");
const BEUpdateManager_1 = __importDefault(require("../support/BEUpdateManager"));
const ScreenRecorderLog_1 = require("../support/ScreenRecorderLog");
const SAMPLE_HANDLER_FILE = 'SampleHandler.swift';
/**
 * Copies the ReplayKit Broadcast Upload Extension templates into the iOS
 * project and patches them so their App Group + bundle versions match the
 * host app. Mirrors OneSignal's NSE flow for consistency.
 */
const withBroadcastExtensionFiles = (config, props) => {
    return (0, config_plugins_1.withDangerousMod)(config, [
        'ios',
        async (mod) => {
            var _a, _b, _c, _d;
            const iosPath = path.join(mod.modRequest.projectRoot, 'ios');
            const targetName = (0, iosConstants_1.getBroadcastExtensionTargetName)(props);
            const sourceDir = path.join(__dirname, '..', 'support', 'broadcastExtensionFiles');
            fs.mkdirSync(`${iosPath}/${targetName}`, {
                recursive: true,
            });
            for (const extFile of iosConstants_1.BROADCAST_EXT_ALL_FILES) {
                const targetFile = `${iosPath}/${targetName}/${extFile}`;
                await FileManager_1.FileManager.copyFile(`${sourceDir}/${extFile}`, targetFile);
            }
            const sourceSamplePath = `${sourceDir}/${SAMPLE_HANDLER_FILE}`;
            const targetSamplePath = `${iosPath}/${targetName}/${SAMPLE_HANDLER_FILE}`;
            await FileManager_1.FileManager.copyFile(sourceSamplePath, targetSamplePath);
            ScreenRecorderLog_1.ScreenRecorderLog.log(`Copied broadcast extension files to ${iosPath}/${targetName}`);
            /* ------------------------------------------------------------ */
            /* 2️⃣  Patch entitlements & Info.plist placeholders              */
            /* ------------------------------------------------------------ */
            const updater = new BEUpdateManager_1.default(iosPath, props);
            const mainAppBundleId = (_a = mod.ios) === null || _a === void 0 ? void 0 : _a.bundleIdentifier;
            if (!mainAppBundleId) {
                throw new Error('Failed to find main app bundle id!');
            }
            const groupIdentifier = (0, iosConstants_1.getAppGroup)(mainAppBundleId, props);
            await updater.updateEntitlements(groupIdentifier);
            await updater.updateInfoPlist((_c = (_b = mod.ios) === null || _b === void 0 ? void 0 : _b.buildNumber) !== null && _c !== void 0 ? _c : iosConstants_1.DEFAULT_BUNDLE_VERSION, groupIdentifier);
            await updater.updateBundleShortVersion((_d = mod.version) !== null && _d !== void 0 ? _d : iosConstants_1.DEFAULT_BUNDLE_SHORT_VERSION);
            ScreenRecorderLog_1.ScreenRecorderLog.log('Patched broadcast extension entitlements and Info.plist with app group and version values.');
            return mod;
        },
    ]);
};
exports.withBroadcastExtensionFiles = withBroadcastExtensionFiles;
