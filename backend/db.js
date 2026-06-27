require('dotenv').config();
const mysql = require('mysql2');

const db = mysql.createPool({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit:    10,
    queueLimit:         0
});

db.getConnection((err, connection) => {
    if (err) {
        console.error("❌ Database Connection Failed");
        console.error(err);
        process.exit(1);
    }
    console.log("✅ MySQL Connected Successfully");
    connection.release();
});

module.exports = db;