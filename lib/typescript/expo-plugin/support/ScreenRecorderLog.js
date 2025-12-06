"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScreenRecorderLog = void 0;
class ScreenRecorderLog {
    static log(message, ...optional) {
        const green = '\x1b[32m';
        const reset = '\x1b[0m';
        console.log(`${green}[${this.PLUGIN}]${reset} ${message}`, ...optional);
    }
    static error(message, ...optional) {
        const red = '\x1b[31m';
        const reset = '\x1b[0m';
        console.error(`${red}[${this.PLUGIN}]${reset} ${message}`, ...optional);
    }
}
exports.ScreenRecorderLog = ScreenRecorderLog;
ScreenRecorderLog.PLUGIN = 'react-native-nitro-screen-recorder';
