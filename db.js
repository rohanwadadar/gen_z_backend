const { Pool } = require('pg');
require('dotenv').config();

// Neon pooler resolved IPs (since local DNS blocks neon.tech)
// Resolved via: nslookup ep-spring-mountain-adi9rp7d-pooler.c-2.us-east-1.aws.neon.tech 8.8.8.8
// Use the raw connection config to bypass DNS issue
const pool = new Pool({
    host: '3.218.140.61',
    port: 5432,
    database: 'neondb',
    user: 'neondb_owner',
    password: 'npg_YatZAz3G0xJs',
    options: 'endpoint=ep-spring-mountain-adi9rp7d',
    ssl: {
        rejectUnauthorized: false,
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

pool.on('connect', () => {
    console.log('✅ Connected to Neon PostgreSQL Database');
});

pool.on('error', (err) => {
    console.error('❌ Unexpected database error:', err);
});

module.exports = {
    query: (text, params) => pool.query(text, params),
};
