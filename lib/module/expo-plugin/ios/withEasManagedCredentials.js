"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.withEasManagedCredentials = void 0;
const getEasManagedCredentials_1 = __importDefault(require("../eas/getEasManagedCredentials"));
const withEasManagedCredentials = (config, props) => {
    config.extra = (0, getEasManagedCredentials_1.default)(config, props);
    return config;
};
exports.withEasManagedCredentials = withEasManagedCredentials;
