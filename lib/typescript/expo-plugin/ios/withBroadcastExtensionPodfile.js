"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.withBroadcastExtensionPodfile = void 0;
const path_1 = __importDefault(require("path"));
const config_plugins_1 = require("@expo/config-plugins");
const updatePodfile_1 = require("../support/updatePodfile");
const ScreenRecorderLog_1 = require("../support/ScreenRecorderLog");
const withBroadcastExtensionPodfile = (config, props) => {
    return (0, config_plugins_1.withDangerousMod)(config, [
        'ios',
        async (mod) => {
            const iosRoot = path_1.default.join(mod.modRequest.projectRoot, 'ios');
            await (0, updatePodfile_1.updatePodfile)(iosRoot, props).catch(ScreenRecorderLog_1.ScreenRecorderLog.error);
            return mod;
        },
    ]);
};
exports.withBroadcastExtensionPodfile = withBroadcastExtensionPodfile;
