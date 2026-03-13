const db = require('./db');
async function test() {
    try {
        const res = await db.query('SELECT NOW()');
        console.log('Connected:', res.rows[0]);
        process.exit(0);
    } catch (err) {
        console.error('Connection error:', err);
        process.exit(1);
    }
}
test();
