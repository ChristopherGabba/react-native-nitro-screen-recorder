"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withBroadcastExtension = void 0;
const config_plugins_1 = require("@expo/config-plugins");
// Local helpers / sub‑mods ▶️
const withMainAppAppGroupInfoPlist_1 = require("./withMainAppAppGroupInfoPlist");
const withMainAppAppGroupEntitlement_1 = require("./withMainAppAppGroupEntitlement");
const withBroadcastExtensionFiles_1 = require("./withBroadcastExtensionFiles");
const withBroadcastExtensionXcodeProject_1 = require("./withBroadcastExtensionXcodeProject");
const withBroadcastExtensionPodfile_1 = require("./withBroadcastExtensionPodfile");
const withEasManagedCredentials_1 = require("./withEasManagedCredentials");
const withMainAppEntitlementsFile_1 = require("./withMainAppEntitlementsFile");
const withBroadcastExtension = (config, props) => {
    return (0, config_plugins_1.withPlugins)(config, [
        /** Main‑app tweaks */
        [withMainAppAppGroupInfoPlist_1.withMainAppAppGroupInfoPlist, props],
        [withMainAppEntitlementsFile_1.withMainAppEntitlementsFile, props],
        [withMainAppAppGroupEntitlement_1.withMainAppAppGroupEntitlement, props],
        /** Broadcast extension target */
        [withBroadcastExtensionFiles_1.withBroadcastExtensionFiles, props],
        [withBroadcastExtensionXcodeProject_1.withBroadcastExtensionXcodeProject, props],
        [withBroadcastExtensionPodfile_1.withBroadcastExtensionPodfile, props],
        /** Extras for EAS build */
        [withEasManagedCredentials_1.withEasManagedCredentials, props],
    ]);
};
exports.withBroadcastExtension = withBroadcastExtension;
