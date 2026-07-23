require('dotenv').config();
const mysql = require('mysql2');
const fs    = require('fs');

// Aiven (and most managed MySQL hosts) require TLS + a non-default port.
// Set DB_SSL=true in .env to enable it. If you download Aiven's CA
// certificate, point DB_CA_CERT_PATH at it for full verification;
// otherwise it falls back to an encrypted-but-unverified connection.
const useSSL = process.env.DB_SSL === 'true';
let sslConfig;
if (useSSL) {
    sslConfig = process.env.DB_CA_CERT_PATH
        ? { ca: fs.readFileSync(process.env.DB_CA_CERT_PATH), rejectUnauthorized: true }
        : { rejectUnauthorized: false };
}

const db = mysql.createPool({
    host:     process.env.DB_HOST,
    port:     process.env.DB_PORT || 3306,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit:    10,
    queueLimit:         0,
    ...(useSSL ? { ssl: sslConfig } : {})
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