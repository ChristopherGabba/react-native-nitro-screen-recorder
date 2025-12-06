"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
var _useGlobalRecording = require("./useGlobalRecording");
Object.keys(_useGlobalRecording).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (key in exports && exports[key] === _useGlobalRecording[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _useGlobalRecording[key];
    }
  });
});
//# sourceMappingURL=index.js.map