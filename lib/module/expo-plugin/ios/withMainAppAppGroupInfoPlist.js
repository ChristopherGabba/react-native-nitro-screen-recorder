"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.withMainAppAppGroupInfoPlist = void 0;
const config_plugins_1 = require("@expo/config-plugins");
const iosConstants_1 = require("../support/iosConstants");
const iosConstants_2 = require("../support/iosConstants");
const assert_1 = __importDefault(require("assert"));
const withMainAppAppGroupInfoPlist = (config, props) => {
    return (0, config_plugins_1.withInfoPlist)(config, (modConfig) => {
        var _a;
        const appIdentifier = (_a = modConfig.ios) === null || _a === void 0 ? void 0 : _a.bundleIdentifier;
        (0, assert_1.default)(appIdentifier, "Missing 'ios.bundleIdentifier' in app config");
        const appGroup = (0, iosConstants_1.getAppGroup)(appIdentifier, props);
        const broadcastExtensionBundleId = (0, iosConstants_2.getBroadcastExtensionBundleIdentifier)(appIdentifier, props);
        modConfig.modResults.BroadcastExtensionAppGroupIdentifier = appGroup;
        modConfig.modResults.BroadcastExtensionBundleIdentifier =
            broadcastExtensionBundleId;
        return modConfig;
    });
};
exports.withMainAppAppGroupInfoPlist = withMainAppAppGroupInfoPlist;
