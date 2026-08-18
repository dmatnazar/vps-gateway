"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
* Integration test script to verify full CRUD operations and sync_log auditing
* on the VPS Gateway SQLite control plane database.
*
* Runs without needing a live network connection by invoking repository and controller logic directly.
*/
const tenant_repository_1 = require("./modules/tenant/tenant.repository");
const sqliteDb_1 = require("./store/sqliteDb");
const node_crypto_1 = __importDefault(require("node:crypto"));
async function runTests() {
    console.log('🧪 Starting VPS Gateway SQLite & CRUD Sync Verification Tests...\n');
    // Initialize DB
    const db = (0, sqliteDb_1.getDb)();
    console.log('1. DB initialized successfully.');
    // Test 1: Create Tenant (Company)
    console.log('\n--- Test 1: Tenant (Company) CRUD ---');
    const testSlug = `test-company-${Date.now()}`;
    const tenant = await tenant_repository_1.tenantRepository.create({
        slug: testSlug,
        name: 'Test Enterprise Ltd',
        dbConnEnc: 'enc_conn_dummy',
        dbConnIv: 'iv_dummy',
    });
    console.log('✅ Created Tenant:', tenant.id, tenant.slug);
    let foundTenant = await tenant_repository_1.tenantRepository.findBySlug(testSlug);
    if (!foundTenant || foundTenant.name !== 'Test Enterprise Ltd') {
        throw new Error('❌ Tenant creation verification failed!');
    }
    console.log('✅ Verified Tenant lookup by slug.');
    // Update Tenant Connections
    await tenant_repository_1.tenantRepository.replaceConnections(tenant.id, [
        {
            dbKey: 'primary',
            label: 'Main DB',
            database: 'TestDB_Main',
            dbConnEnc: 'enc_conn_main',
            dbConnIv: 'iv_main',
        },
        {
            dbKey: 'analytics',
            label: 'Analytics DB',
            database: 'TestDB_Analytics',
            dbConnEnc: 'enc_conn_analytics',
            dbConnIv: 'iv_analytics',
        },
    ]);
    console.log('✅ Updated Tenant Multi-DB connections.');
    foundTenant = await tenant_repository_1.tenantRepository.findBySlug(testSlug);
    if (foundTenant?.connections?.length !== 2) {
        throw new Error('❌ Tenant multi-connection update failed!');
    }
    console.log('✅ Verified multi-connection list count:', foundTenant.connections.length);
    // Test 2: Endpoint (API) CRUD
    console.log('\n--- Test 2: Endpoint (API) CRUD ---');
    await tenant_repository_1.tenantRepository.replaceEndpoints(tenant.id, [
        {
            name: 'getUsers',
            method: 'GET',
            pathTemplate: '/users',
            sqlQuery: 'SELECT * FROM users',
            paramsSchema: { urlParams: [], queryParams: [], bodyParams: [] },
            cacheTtlSec: 0,
            authRequired: true,
            dbKey: 'primary',
        },
        {
            name: 'getMetrics',
            method: 'GET',
            pathTemplate: '/metrics',
            sqlQuery: 'SELECT * FROM metrics',
            paramsSchema: { urlParams: [], queryParams: [], bodyParams: [] },
            cacheTtlSec: 60,
            authRequired: false,
            dbKey: 'analytics',
        },
    ]);
    console.log('✅ Created/Replaced Endpoints for Tenant.');
    const endpoints = await tenant_repository_1.tenantRepository.listAllEndpoints();
    const tenantEndpoints = endpoints.filter((e) => e.tenantSlug === testSlug);
    if (tenantEndpoints.length !== 2) {
        throw new Error('❌ Endpoint listing count mismatch!');
    }
    console.log('✅ Verified endpoints list count:', tenantEndpoints.length);
    // Test 3: Staff CRUD
    console.log('\n--- Test 3: Staff CRUD ---');
    const staffId = node_crypto_1.default.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
    INSERT INTO staff (id, tenant_slug, tenant_slugs, full_name, username, password_hash, role, phone, email, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(staffId, testSlug, JSON.stringify([testSlug]), 'Test Administrator', `admin_${Date.now()}`, 'salt:hash', 'admin', '+99365000000', 'test@example.com', now, now);
    console.log('✅ Created Staff member.');
    const staffRow = db.prepare(`SELECT * FROM staff WHERE id = ?`).get(staffId);
    if (!staffRow || staffRow.full_name !== 'Test Administrator') {
        throw new Error('❌ Staff creation verification failed!');
    }
    console.log('✅ Verified Staff record in DB.');
    // Update Staff role
    db.prepare(`UPDATE staff SET role = ?, updated_at = ? WHERE id = ?`).run('editor', new Date().toISOString(), staffId);
    const updatedStaff = db.prepare(`SELECT role FROM staff WHERE id = ?`).get(staffId);
    if (updatedStaff.role !== 'editor') {
        throw new Error('❌ Staff update failed!');
    }
    console.log('✅ Verified Staff role update.');
    // Test 4: Verify sync_log audit trail
    console.log('\n--- Test 4: sync_log Audit Trail Verification ---');
    const logs = (0, sqliteDb_1.getSyncLogs)({ limit: 10 });
    if (logs.length === 0) {
        throw new Error('❌ Audit logs empty! sync_log is not recording mutations!');
    }
    console.log(`✅ Found ${logs.length} recent sync_log entries:`);
    for (const log of logs.slice(0, 5)) {
        console.log(`   • [ID ${log.id}] Action: ${log.action} | Entity: ${log.entity_type} (${log.entity_id || 'N/A'}) | Source: ${log.source} | Time: ${log.created_at}`);
    }
    // Cleanup test tenant
    console.log('\n--- Cleanup ---');
    db.prepare(`DELETE FROM tenants WHERE id = ?`).run(tenant.id);
    console.log('✅ Test company cleaned up.');
    console.log('\n🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY!\n');
}
runTests().catch((err) => {
    console.error('\n❌ TEST FAILED:', err);
    process.exit(1);
});
//# sourceMappingURL=test-sync.js.map