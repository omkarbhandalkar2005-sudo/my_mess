require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcrypt');
const https      = require('https');
const app        = express();
const db         = require('./db');

app.use(cors());
app.use(express.json());

const TIFFIN_PRICE  = 70;
const FAST_PRICE    = 40;
const ROTI_PRICE    = 15;
const BHAKARI_PRICE = 20;

const otpStore      = {};
const resetOtpStore = {};

// Brevo API se email bhejo
function sendEmail(to, subject, htmlContent, callback) {
    const data = JSON.stringify({
        sender: { name: "Mess Tracker", email: "messtrackerapp@gmail.com" },
        to: [{ email: to }],
        subject: subject,
        htmlContent: htmlContent
    });

    const options = {
        hostname: 'api.brevo.com',
        path:     '/v3/smtp/email',
        method:   'POST',
        headers: {
            'Content-Type':  'application/json',
            'api-key':       process.env.BREVO_API_KEY,
            'Content-Length': Buffer.byteLength(data)
        }
    };

    const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                callback(null);
            } else {
                callback(new Error(`Brevo error: ${body}`));
            }
        });
    });

    req.on('error', callback);
    req.write(data);
    req.end();
}

// TEST
app.get('/', (req, res) => {
    res.status(200).send("The server is up and running 🚀");
});

// SEND OTP
app.post('/send-otp', (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: "Email required" });
    }

    db.query("SELECT id FROM customers WHERE email = ?", [email], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Server error" });
        }

        if (result.length > 0) {
            return res.status(409).json({ message: "Email already registered" });
        }

        const otp    = Math.floor(100000 + Math.random() * 900000).toString();
        const expiry = Date.now() + 5 * 60 * 1000;

        otpStore[email] = { otp, expiry };

        const html = `
            <h2>Mess Tracker Registration</h2>
            <p>Your OTP is:</p>
            <h1 style="color: #4CAF50; letter-spacing: 5px;">${otp}</h1>
            <p>This OTP will expire in 5 minutes.</p>
        `;

        sendEmail(email, "Mess Tracker - OTP Verification", html, (err) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: "Error sending OTP" });
            }
            return res.status(200).json({ message: "OTP sent successfully ✅" });
        });
    });
});

// REGISTER
app.post('/register', (req, res) => {
    const { name, contact, email, password, otp } = req.body;

    if (!name || !contact || !email || !password || !otp) {
        return res.status(400).json({ message: "All fields are required" });
    }

    const stored = otpStore[email];

    if (!stored) {
        return res.status(400).json({ message: "Pehle OTP bhejo" });
    }

    if (Date.now() > stored.expiry) {
        delete otpStore[email];
        return res.status(400).json({ message: "OTP expire ho gaya, dobara bhejo" });
    }

    if (stored.otp !== otp) {
        return res.status(400).json({ message: "Galat OTP" });
    }

    delete otpStore[email];

    bcrypt.hash(password, 10, (err, hash) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error creating account" });
        }

        const sql = `INSERT INTO customers (name, contact, email, password, role)
                     VALUES (?, ?, ?, ?, ?)`;

        db.query(sql, [name, contact, email, hash, "customer"], (err) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: "Error registering user" });
            }

            return res.status(201).json({ message: "Registration successful ✅" });
        });
    });
});

// LOGIN
app.post('/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
    }

    db.query("SELECT * FROM customers WHERE email = ?", [email], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error logging in" });
        }

        if (result.length === 0) {
            return res.status(401).json({ message: "Invalid email or password" });
        }

        bcrypt.compare(password, result[0].password, (err, match) => {
            if (err || !match) {
                return res.status(401).json({ message: "Invalid email or password" });
            }

            return res.status(200).json({
                message:    "Login successful",
                role:       String(result[0].role || "customer").toLowerCase().trim(),
                customer_id: result[0].id,
                name:       result[0].name,
                contact:    result[0].contact,
                email:      result[0].email
            });
        });
    });
});

// FORGOT PASSWORD - SEND OTP
app.post('/forgot-password/send-otp', (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: "Email required" });
    }

    db.query("SELECT id FROM customers WHERE email = ?", [email], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Server error" });
        }

        // Security: same message chahe email exist kare ya na kare, taaki koi ye pata na laga sake
        // ki kaunse emails registered hain. Lekin OTP sirf tabhi bhejenge jab email exist kare.
        if (result.length === 0) {
            return res.status(200).json({ message: "Agar ye email registered hai, to OTP bhej diya gaya hai ✅" });
        }

        const otp    = Math.floor(100000 + Math.random() * 900000).toString();
        const expiry = Date.now() + 5 * 60 * 1000;

        resetOtpStore[email] = { otp, expiry };

        const html = `
            <h2>Mess Tracker - Password Reset</h2>
            <p>Your OTP to reset your password is:</p>
            <h1 style="color: #4CAF50; letter-spacing: 5px;">${otp}</h1>
            <p>This OTP will expire in 5 minutes.</p>
            <p>Agar tumne ye request nahi ki, to is email ko ignore kar do.</p>
        `;

        sendEmail(email, "Mess Tracker - Password Reset OTP", html, (err) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: "Error sending OTP" });
            }
            return res.status(200).json({ message: "Agar ye email registered hai, to OTP bhej diya gaya hai ✅" });
        });
    });
});

// FORGOT PASSWORD - VERIFY OTP & RESET
app.post('/forgot-password/reset', (req, res) => {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
        return res.status(400).json({ message: "All fields are required" });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ message: "Password kam se kam 6 characters ka hona chahiye" });
    }

    const stored = resetOtpStore[email];

    if (!stored) {
        return res.status(400).json({ message: "Pehle OTP bhejo" });
    }

    if (Date.now() > stored.expiry) {
        delete resetOtpStore[email];
        return res.status(400).json({ message: "OTP expire ho gaya, dobara bhejo" });
    }

    if (stored.otp !== otp) {
        return res.status(400).json({ message: "Galat OTP" });
    }

    delete resetOtpStore[email];

    bcrypt.hash(newPassword, 10, (err, hash) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error resetting password" });
        }

        db.query("UPDATE customers SET password = ? WHERE email = ?", [hash, email], (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: "Error updating password" });
            }

            if (result.affectedRows === 0) {
                return res.status(404).json({ message: "Account not found" });
            }

            return res.status(200).json({ message: "Password reset successful ✅ Ab login kar sakte ho" });
        });
    });
});

// ADD TIFFIN
app.post('/add-tiffin', (req, res) => {
    const { customer_id, date, type, quantity, extra_roti, extra_bhakari } = req.body;

    if (!customer_id || !date || !type || quantity == null) {
        return res.status(400).json({ message: "All required fields are mandatory" });
    }

    const sql = `INSERT INTO tiffin (customer_id, date, type, quantity, extra_roti, extra_bhakari)
                 VALUES (?, ?, ?, ?, ?, ?)`;

    db.query(sql, [customer_id, date, type, quantity, extra_roti || 0, extra_bhakari || 0], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error adding tiffin" });
        }

        return res.status(201).json({ message: "Tiffin added successfully 🍱" });
    });
});

// ADD PAYMENT
app.post('/add-payment', (req, res) => {
    const { customer_id, amount_paid, date } = req.body;

    if (!customer_id || !amount_paid || !date) {
        return res.status(400).json({ message: "All fields are required" });
    }

    const sql = `INSERT INTO payments (customer_id, amount_paid, date)
                 VALUES (?, ?, ?)`;

    db.query(sql, [customer_id, amount_paid, date], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error adding payment" });
        }

        return res.status(201).json({ message: "Payment recorded successfully 💰" });
    });
});

// TIFFIN HISTORY
app.get('/tiffin-history/:id', (req, res) => {
    const sql = `SELECT id, date, type, quantity, extra_roti, extra_bhakari
                 FROM tiffin WHERE customer_id = ?
                 ORDER BY date DESC`;

    db.query(sql, [req.params.id], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error fetching tiffin history" });
        }

        res.json(result);
    });
});

// DELETE TIFFIN
app.delete('/tiffin/:id', (req, res) => {
    const sql = `DELETE FROM tiffin WHERE id = ?`;

    db.query(sql, [req.params.id], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error deleting tiffin" });
        }

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Tiffin record not found" });
        }

        return res.status(200).json({ message: "Tiffin entry deleted successfully 🗑️" });
    });
});

// PAYMENT HISTORY
app.get('/payment-history/:id', (req, res) => {
    const sql = `SELECT date, amount_paid
                 FROM payments WHERE customer_id = ?
                 ORDER BY date DESC`;

    db.query(sql, [req.params.id], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error fetching payment history" });
        }

        res.json(result);
    });
});

// FINAL BILL
app.get('/final-bill/:id', (req, res) => {
    const id = req.params.id;

    const tiffinSql = `SELECT
                              SUM(CASE WHEN type = 'Fast' THEN quantity ELSE 0 END) AS fastTiffin,
                              SUM(CASE WHEN type != 'Fast' THEN quantity ELSE 0 END) AS regularTiffin,
                              SUM(extra_roti) AS totalRoti,
                              SUM(extra_bhakari) AS totalBhakari
                       FROM tiffin WHERE customer_id = ?`;

    const paymentSql = `SELECT SUM(amount_paid) AS totalPaid
                        FROM payments WHERE customer_id = ?`;

    db.query(tiffinSql, [id], (err, tiffinResult) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error calculating bill" });
        }

        db.query(paymentSql, [id], (err, paymentResult) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: "Error calculating payment" });
            }

            const t = tiffinResult[0] || {};
            const totalTiffin = (t.fastTiffin || 0) + (t.regularTiffin || 0);

            const totalAmount =
                (t.regularTiffin || 0) * TIFFIN_PRICE  +
                (t.fastTiffin    || 0) * FAST_PRICE    +
                (t.totalRoti     || 0) * ROTI_PRICE    +
                (t.totalBhakari  || 0) * BHAKARI_PRICE;

            const totalPaid = paymentResult[0].totalPaid || 0;
            const pending   = totalAmount - totalPaid;

            res.status(200).json({
                totalTiffin:  totalTiffin,
                extraRoti:    t.totalRoti    || 0,
                extraBhakari: t.totalBhakari || 0,
                totalAmount,
                totalPaid,
                pending,
                status: pending <= 0 ? "Paid ✅" : "Pending ❌"
            });
        });
    });
});

// ALL CUSTOMERS SUMMARY (Admin list — name, id, total tiffins, total bill)
app.get('/all-customers-summary', (req, res) => {
    const customersSql = `SELECT id, name FROM customers WHERE role = 'customer' ORDER BY id ASC`;

    const tiffinSql = `SELECT customer_id,
                              SUM(CASE WHEN type = 'Fast' THEN quantity ELSE 0 END) AS fastTiffin,
                              SUM(CASE WHEN type != 'Fast' THEN quantity ELSE 0 END) AS regularTiffin,
                              SUM(extra_roti) AS totalRoti,
                              SUM(extra_bhakari) AS totalBhakari
                       FROM tiffin GROUP BY customer_id`;

    const paymentSql = `SELECT customer_id, SUM(amount_paid) AS totalPaid
                        FROM payments GROUP BY customer_id`;

    db.query(customersSql, (err, customers) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error fetching customers" });
        }

        db.query(tiffinSql, (err, tiffinRows) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: "Error fetching tiffin data" });
            }

            db.query(paymentSql, (err, paymentRows) => {
                if (err) {
                    console.error(err);
                    return res.status(500).json({ message: "Error fetching payment data" });
                }

                const tiffinMap  = {};
                tiffinRows.forEach(row => { tiffinMap[row.customer_id] = row; });

                const paymentMap = {};
                paymentRows.forEach(row => { paymentMap[row.customer_id] = row.totalPaid || 0; });

                const summary = customers.map(c => {
                    const t = tiffinMap[c.id] || {};
                    const totalTiffin = (t.fastTiffin || 0) + (t.regularTiffin || 0);

                    const totalAmount =
                        (t.regularTiffin || 0) * TIFFIN_PRICE  +
                        (t.fastTiffin    || 0) * FAST_PRICE    +
                        (t.totalRoti     || 0) * ROTI_PRICE    +
                        (t.totalBhakari  || 0) * BHAKARI_PRICE;

                    const totalPaid = paymentMap[c.id] || 0;
                    const pending   = totalAmount - totalPaid;

                    return {
                        id: c.id,
                        name: c.name,
                        totalTiffin,
                        totalAmount,
                        totalPaid,
                        pending
                    };
                });

                res.status(200).json(summary);
            });
        });
    });
});

// SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
