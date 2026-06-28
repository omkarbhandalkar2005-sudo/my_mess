require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const bcrypt       = require('bcrypt');
const nodemailer   = require('nodemailer');
const app          = express();
const db           = require('./db');

app.use(cors());
app.use(express.json());

const TIFFIN_PRICE  = 70;
const ROTI_PRICE    = 10;
const BHAKARI_PRICE = 10;

// OTP store (email -> { otp, expiry })
const otpStore = {};

// Nodemailer setup
const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   process.env.SMTP_PORT,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});
// TEST
app.get('/', (req, res) => {
    res.status(200).send("Server chal raha hai bro 🚀");
});

// SEND OTP
app.post('/send-otp', (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: "Email required" });
    }

    db.query("SELECT id FROM students WHERE email = ?", [email], (err, result) => {
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

        const mailOptions = {
            from:    process.env.GMAIL_USER,
            to:      email,
            subject: "Mess Tracker - OTP Verification",
            html: `
                <h2>Mess Tracker Registration</h2>
                <p>Tumhara OTP hai:</p>
                <h1 style="color: #4CAF50; letter-spacing: 5px;">${otp}</h1>
                <p>Yeh OTP 5 minutes mein expire ho jayega.</p>
            `
        };

        transporter.sendMail(mailOptions, (err) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: "OTP send karne mein error" });
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

        const sql = `INSERT INTO students (name, contact, email, password, role)
                     VALUES (?, ?, ?, ?, ?)`;

        db.query(sql, [name, contact, email, hash, "student"], (err) => {
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

    db.query("SELECT * FROM students WHERE email = ?", [email], (err, result) => {
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
                role:       String(result[0].role || "student").toLowerCase().trim(),
                student_id: result[0].id,
                name:       result[0].name
            });
        });
    });
});

// ADD TIFFIN
app.post('/add-tiffin', (req, res) => {
    const { student_id, date, type, quantity, extra_roti, extra_bhakari } = req.body;

    if (!student_id || !date || !type || quantity == null) {
        return res.status(400).json({ message: "All required fields are mandatory" });
    }

    const sql = `INSERT INTO tiffin (student_id, date, type, quantity, extra_roti, extra_bhakari)
                 VALUES (?, ?, ?, ?, ?, ?)`;

    db.query(sql, [student_id, date, type, quantity, extra_roti || 0, extra_bhakari || 0], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error adding tiffin" });
        }

        return res.status(201).json({ message: "Tiffin added successfully 🍱" });
    });
});

// ADD PAYMENT
app.post('/add-payment', (req, res) => {
    const { student_id, amount_paid, date } = req.body;

    if (!student_id || !amount_paid || !date) {
        return res.status(400).json({ message: "All fields are required" });
    }

    const sql = `INSERT INTO payments (student_id, amount_paid, date)
                 VALUES (?, ?, ?)`;

    db.query(sql, [student_id, amount_paid, date], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error adding payment" });
        }

        return res.status(201).json({ message: "Payment recorded successfully 💰" });
    });
});

// TIFFIN HISTORY
app.get('/tiffin-history/:id', (req, res) => {
    const sql = `SELECT date, type, quantity, extra_roti, extra_bhakari
                 FROM tiffin WHERE student_id = ?
                 ORDER BY date DESC`;

    db.query(sql, [req.params.id], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error fetching tiffin history" });
        }

        res.json(result);
    });
});

// PAYMENT HISTORY
app.get('/payment-history/:id', (req, res) => {
    const sql = `SELECT date, amount_paid
                 FROM payments WHERE student_id = ?
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

    const tiffinSql = `SELECT SUM(quantity) AS totalTiffin,
                              SUM(extra_roti) AS totalRoti,
                              SUM(extra_bhakari) AS totalBhakari
                       FROM tiffin WHERE student_id = ?`;

    const paymentSql = `SELECT SUM(amount_paid) AS totalPaid
                        FROM payments WHERE student_id = ?`;

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

            const totalAmount =
                (t.totalTiffin  || 0) * TIFFIN_PRICE  +
                (t.totalRoti    || 0) * ROTI_PRICE     +
                (t.totalBhakari || 0) * BHAKARI_PRICE;

            const totalPaid = paymentResult[0].totalPaid || 0;
            const pending   = totalAmount - totalPaid;

            res.status(200).json({
                totalTiffin:  t.totalTiffin  || 0,
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

// SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
