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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileManager = void 0;
const fs = __importStar(require("fs"));
const ScreenRecorderLog_1 = require("./ScreenRecorderLog");
/**
 * FileManager contains static *awaitable* file-system functions
 */
class FileManager {
    static async readFile(path) {
        return new Promise((resolve, reject) => {
            fs.readFile(path, 'utf8', (err, data) => {
                if (err || !data) {
                    ScreenRecorderLog_1.ScreenRecorderLog.error("Couldn't read file:" + path);
                    reject(err);
                    return;
                }
                resolve(data);
            });
        });
    }
    static async writeFile(path, contents) {
        return new Promise((resolve, reject) => {
            fs.writeFile(path, contents, 'utf8', (err) => {
                if (err) {
                    ScreenRecorderLog_1.ScreenRecorderLog.error("Couldn't write file:" + path);
                    reject(err);
                    return;
                }
                resolve();
            });
        });
    }
    static async copyFile(path1, path2) {
        const fileContents = await FileManager.readFile(path1);
        await FileManager.writeFile(path2, fileContents);
    }
    static dirExists(path) {
        return fs.existsSync(path);
    }
}
exports.FileManager = FileManager;
