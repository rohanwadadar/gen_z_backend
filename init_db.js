const db = require('./db');
const fs = require('fs');
const path = require('path');

const initDb = async () => {
    try {
        const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
        await db.query(schema);
        console.log("Database table initialized successfully.");
        process.exit(0);
    } catch (err) {
        console.error("Error initializing database:", err);
        process.exit(1);
    }
};

initDb();
