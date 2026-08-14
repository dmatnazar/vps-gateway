"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.closeDb = exports.getSyncLogs = exports.logSync = exports.getDb = void 0;
/**
 * Database abstraction module for VPS Gateway.
 * Re-exports SQLite DB instance and helper methods from sqliteDb.ts.
 */
var sqliteDb_1 = require("./sqliteDb");
Object.defineProperty(exports, "getDb", { enumerable: true, get: function () { return sqliteDb_1.getDb; } });
Object.defineProperty(exports, "logSync", { enumerable: true, get: function () { return sqliteDb_1.logSync; } });
Object.defineProperty(exports, "getSyncLogs", { enumerable: true, get: function () { return sqliteDb_1.getSyncLogs; } });
Object.defineProperty(exports, "closeDb", { enumerable: true, get: function () { return sqliteDb_1.closeDb; } });
//# sourceMappingURL=db.js.map