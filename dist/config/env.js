"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
require("dotenv/config");
const zod_1 = require("zod");
const EnvSchema = zod_1.z.object({
    PORT: zod_1.z.coerce.number().default(4000),
    HOST: zod_1.z.string().default('0.0.0.0'),
    JWT_SECRET: zod_1.z.string().min(8, 'JWT_SECRET must be set'),
    ADMIN_SYNC_SECRET: zod_1.z.string().min(8, 'ADMIN_SYNC_SECRET must be set'),
    CONN_STRING_SECRET: zod_1.z
        .string()
        .length(64, 'CONN_STRING_SECRET must be a 64-char hex string (32 bytes)'),
    DB_FILE: zod_1.z.string().default('./data/metadata.json'),
});
const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
    console.error('❌ Invalid environment configuration:');
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
}
exports.env = parsed.data;
//# sourceMappingURL=env.js.map