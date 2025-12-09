"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withMainAppEntitlementsFile = void 0;
const config_plugins_1 = require("@expo/config-plugins");
const ScreenRecorderLog_1 = require("../support/ScreenRecorderLog");
/**
 * Add the main app's entitlements file to the Xcode project navigator
 * This ensures the .entitlements file is visible in Xcode's file tree
 */
const withMainAppEntitlementsFile = (config) => {
    return (0, config_plugins_1.withXcodeProject)(config, (newConfig) => {
        const xcodeProject = newConfig.modResults;
        const projectName = newConfig.name;
        const entitlementsFileName = `${projectName}.entitlements`;
        const entitlementsPath = `${projectName}/${entitlementsFileName}`;
        // Check if the entitlements file is already added to the project
        const files = xcodeProject.hash.project.objects.PBXFileReference;
        // Safety check: ensure files object exists
        if (!files) {
            ScreenRecorderLog_1.ScreenRecorderLog.log('PBXFileReference not found in project. Skipping entitlements file addition.');
            return newConfig;
        }
        const entitlementsFileExists = Object.values(files).some((file) => file && file.path === `"${entitlementsFileName}"`);
        if (entitlementsFileExists) {
            ScreenRecorderLog_1.ScreenRecorderLog.log(`${entitlementsFileName} already exists in project. Skipping...`);
            return newConfig;
        }
        // Find the main app group (try multiple approaches)
        const groups = xcodeProject.hash.project.objects.PBXGroup;
        let mainAppGroupKey = null;
        // Debug: log all group names to understand the structure
        ScreenRecorderLog_1.ScreenRecorderLog.log('Available groups:');
        for (const key in groups) {
            const group = groups[key];
            if (group && group.name) {
                ScreenRecorderLog_1.ScreenRecorderLog.log(`  - ${group.name} (key: ${key})`);
            }
        }
        // Try different variations of the project name
        const searchNames = [
            `"${projectName}"`, // Quoted version
            projectName, // Unquoted version
            `"${projectName}/"`, // With trailing slash
            `${projectName}/`, // Unquoted with trailing slash
        ];
        for (const searchName of searchNames) {
            for (const key in groups) {
                const group = groups[key];
                if (group && group.name === searchName) {
                    mainAppGroupKey = key;
                    ScreenRecorderLog_1.ScreenRecorderLog.log(`Found main app group with name: ${searchName}`);
                    break;
                }
            }
            if (mainAppGroupKey)
                break;
        }
        // If still not found, try to find the group that contains AppDelegate or main source files
        if (!mainAppGroupKey && files) {
            ScreenRecorderLog_1.ScreenRecorderLog.log('Trying to find main app group by looking for AppDelegate...');
            for (const key in groups) {
                const group = groups[key];
                if (group && group.children && Array.isArray(group.children)) {
                    // Check if this group contains typical main app files
                    const hasMainAppFiles = group.children.some((childKey) => {
                        var _a, _b, _c;
                        // Safety check: ensure childKey is a valid string
                        if (!childKey || typeof childKey !== 'string') {
                            return false;
                        }
                        const file = files[childKey];
                        return (file &&
                            (((_a = file.path) === null || _a === void 0 ? void 0 : _a.includes('AppDelegate')) ||
                                ((_b = file.path) === null || _b === void 0 ? void 0 : _b.includes('Info.plist')) ||
                                ((_c = file.name) === null || _c === void 0 ? void 0 : _c.includes('AppDelegate'))));
                    });
                    if (hasMainAppFiles) {
                        mainAppGroupKey = key;
                        ScreenRecorderLog_1.ScreenRecorderLog.log(`Found main app group by AppDelegate: ${group.name || 'unnamed'}`);
                        break;
                    }
                }
            }
        }
        if (!mainAppGroupKey) {
            ScreenRecorderLog_1.ScreenRecorderLog.log(`Could not find main app group for ${projectName}. Available groups logged above.`);
            return newConfig;
        }
        // Add the entitlements file to the project
        try {
            // Create the file reference
            const fileRef = xcodeProject.addFile(entitlementsPath, mainAppGroupKey, {
                lastKnownFileType: 'text.plist.entitlements',
                defaultEncoding: 4,
                target: undefined,
            });
            if (fileRef) {
                ScreenRecorderLog_1.ScreenRecorderLog.log(`Successfully added ${entitlementsFileName} to Xcode project navigator`);
            }
        }
        catch (error) {
            ScreenRecorderLog_1.ScreenRecorderLog.log(`Error adding entitlements file to project: ${error}`);
        }
        return newConfig;
    });
};
exports.withMainAppEntitlementsFile = withMainAppEntitlementsFile;
