"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updatePodfile = updatePodfile;
// updatePodfile.ts
const fs_1 = __importDefault(require("fs"));
const iosConstants_1 = require("./iosConstants");
const ScreenRecorderLog_1 = require("./ScreenRecorderLog");
const FileManager_1 = require("./FileManager");
async function updatePodfile(iosPath, props) {
    const podfilePath = `${iosPath}/Podfile`;
    let podfile = await FileManager_1.FileManager.readFile(podfilePath);
    // Skip if already present
    if (podfile.includes((0, iosConstants_1.getBroadcastExtensionTargetName)(props))) {
        ScreenRecorderLog_1.ScreenRecorderLog.log('Extension target already in Podfile. Skipping…');
        return;
    }
    // Inject snippet into every `target 'Something' do … end` that looks like an iOS app
    podfile = podfile.replace(/target ['"][^'"]+['"] do([\s\S]*?)end/g, (block) => block.replace(/\nend$/, `${(0, iosConstants_1.getBroadcastExtensionPodfileSnippet)(props)}\nend`));
    await fs_1.default.promises.writeFile(podfilePath, podfile, 'utf8');
    ScreenRecorderLog_1.ScreenRecorderLog.log('Inserted BroadcastExtension into Podfile.');
}
