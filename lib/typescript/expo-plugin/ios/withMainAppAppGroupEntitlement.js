"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.withMainAppAppGroupEntitlement = void 0;
const config_plugins_1 = require("@expo/config-plugins");
const iosConstants_1 = require("../support/iosConstants");
const assert_1 = __importDefault(require("assert"));
/**
 * Add "App Group" permission
 */
const withMainAppAppGroupEntitlement = (config, props) => {
    const APP_GROUP_KEY = 'com.apple.security.application-groups';
    return (0, config_plugins_1.withEntitlementsPlist)(config, (newConfig) => {
        var _a, _b;
        // Ensure we have an array, preserving any existing entries
        if (!Array.isArray(newConfig.modResults[APP_GROUP_KEY])) {
            newConfig.modResults[APP_GROUP_KEY] = [];
        }
        const modResultsArray = newConfig.modResults[APP_GROUP_KEY];
        (0, assert_1.default)((_a = newConfig.ios) === null || _a === void 0 ? void 0 : _a.bundleIdentifier, "Missing 'ios.bundleIdentifier' in app config");
        const entitlement = (0, iosConstants_1.getAppGroup)((_b = newConfig === null || newConfig === void 0 ? void 0 : newConfig.ios) === null || _b === void 0 ? void 0 : _b.bundleIdentifier, props);
        // Check if our entitlement already exists
        if (modResultsArray.includes(entitlement)) {
            return newConfig;
        }
        modResultsArray.push(entitlement);
        return newConfig;
    });
};
exports.withMainAppAppGroupEntitlement = withMainAppAppGroupEntitlement;
