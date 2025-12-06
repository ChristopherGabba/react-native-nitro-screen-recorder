"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = getEasManagedCredentialsConfigExtra;
const iosConstants_1 = require("../support/iosConstants");
const assert_1 = __importDefault(require("assert"));
function getEasManagedCredentialsConfigExtra(config, props) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v;
    const providedExtensionBundleId = !!props.iosExtensionBundleIdentifier;
    if (!providedExtensionBundleId && !((_a = config.ios) === null || _a === void 0 ? void 0 : _a.bundleIdentifier)) {
        (0, assert_1.default)((_b = config.ios) === null || _b === void 0 ? void 0 : _b.bundleIdentifier, "Missing 'ios.bundleIdentifier' in app config");
    }
    const extensionTargetName = (0, iosConstants_1.getBroadcastExtensionTargetName)(props);
    return {
        ...config.extra,
        eas: {
            ...(_c = config.extra) === null || _c === void 0 ? void 0 : _c.eas,
            build: {
                ...(_e = (_d = config.extra) === null || _d === void 0 ? void 0 : _d.eas) === null || _e === void 0 ? void 0 : _e.build,
                experimental: {
                    ...(_h = (_g = (_f = config.extra) === null || _f === void 0 ? void 0 : _f.eas) === null || _g === void 0 ? void 0 : _g.build) === null || _h === void 0 ? void 0 : _h.experimental,
                    ios: {
                        ...(_m = (_l = (_k = (_j = config.extra) === null || _j === void 0 ? void 0 : _j.eas) === null || _k === void 0 ? void 0 : _k.build) === null || _l === void 0 ? void 0 : _l.experimental) === null || _m === void 0 ? void 0 : _m.ios,
                        appExtensions: [
                            ...((_t = (_s = (_r = (_q = (_p = (_o = config.extra) === null || _o === void 0 ? void 0 : _o.eas) === null || _p === void 0 ? void 0 : _p.build) === null || _q === void 0 ? void 0 : _q.experimental) === null || _r === void 0 ? void 0 : _r.ios) === null || _s === void 0 ? void 0 : _s.appExtensions) !== null && _t !== void 0 ? _t : []),
                            {
                                targetName: extensionTargetName,
                                bundleIdentifier: (0, iosConstants_1.getBroadcastExtensionBundleIdentifier)((_u = config === null || config === void 0 ? void 0 : config.ios) === null || _u === void 0 ? void 0 : _u.bundleIdentifier, props),
                                entitlements: {
                                    'com.apple.security.application-groups': [
                                        (0, iosConstants_1.getAppGroup)((_v = config === null || config === void 0 ? void 0 : config.ios) === null || _v === void 0 ? void 0 : _v.bundleIdentifier, props),
                                    ],
                                },
                            },
                        ],
                    },
                },
            },
        },
    };
}
