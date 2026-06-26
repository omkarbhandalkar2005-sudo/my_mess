const express = require('express');
const cors = require('cors');
const app = express();
const db = require('./db');

app.use(cors());
app.use(express.json());

// TEST
app.get('/', (req, res) => {
    res.send("Server chal raha hai bro 🚀");
});

// REGISTER
app.post('/register', (req, res) => {
    const { name, contact, email, password } = req.body;
    const role = "student";

    const sql = `
    INSERT INTO students (name, contact, email, password, role)
    VALUES (?, ?, ?, ?, ?)
    `;

    db.query(sql, [name, contact, email, password, role], (err) => {
        if (err) {
            console.log(err);
            res.send("Error registering user");
        } else {
            res.send("Registration successful ✅");
        }
    });
});
// LOGIN
app.post('/login', (req, res) => {
    const { email, password } = req.body;

    const sql = "SELECT * FROM students WHERE email = ? AND password = ?";

    db.query(sql, [email, password], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error logging in" });
        }

        if (result.length > 0) {
            return res.status(200).json({
                message: "Login successful",
                role: String(result[0].role || "student").toLowerCase().trim(),
                student_id: result[0].id
            });
        }

        return res.status(401).json({ message: "Invalid email or password" });
    });
});

// ADD TIFFIN
app.post('/add-tiffin', (req, res) => {
    const { student_id, date, type, quantity, extra_roti, extra_bhakari } = req.body;

    const sql = `
    INSERT INTO tiffin (student_id, date, type, quantity, extra_roti, extra_bhakari) 
    VALUES (?, ?, ?, ?, ?, ?)`;

    db.query(sql, [student_id, date, type, quantity, extra_roti, extra_bhakari], (err) => {
        if (err) {
            console.log(err);
            res.send("Error adding tiffin");
        } else {
            res.send("Tiffin added successfully 🍱");
        }
    });
});

// ADD PAYMENT
app.post('/add-payment', (req, res) => {
    const { student_id, amount_paid, date } = req.body;

    const sql = `
    INSERT INTO payments (student_id, amount_paid, date)
    VALUES (?, ?, ?)`;

    db.query(sql, [student_id, amount_paid, date], (err) => {
        if (err) {
            console.log(err);
            res.send("Error adding payment");
        } else {
            res.send("Payment recorded successfully 💰");
        }
    });
});

// TIFFIN HISTORY
app.get('/tiffin-history/:id', (req, res) => {
    const id = req.params.id;

    const sql = `
    SELECT date, type, quantity, extra_roti, extra_bhakari
    FROM tiffin WHERE student_id = ?
    ORDER BY date DESC`;

    db.query(sql, [id], (err, result) => {
        if (err) return res.send("Error");
        res.json(result);
    });
});

// PAYMENT HISTORY
app.get('/payment-history/:id', (req, res) => {
    const id = req.params.id;

    const sql = `
    SELECT date, amount_paid
    FROM payments WHERE student_id = ?
    ORDER BY date DESC`;

    db.query(sql, [id], (err, result) => {
        if (err) return res.send("Error");
        res.json(result);
    });
});

// FINAL BILL
app.get('/final-bill/:id', (req, res) => {
    const id = req.params.id;

    const tiffinSql = `
    SELECT 
        SUM(quantity) AS totalTiffin,
        SUM(extra_roti) AS totalRoti,
        SUM(extra_bhakari) AS totalBhakari
    FROM tiffin WHERE student_id = ?
    `;

    const paymentSql = `
    SELECT SUM(amount_paid) AS totalPaid 
    FROM payments WHERE student_id = ?
    `;

    db.query(tiffinSql, [id], (err, tiffinResult) => {
        if (err) return res.send("Error");

        db.query(paymentSql, [id], (err, paymentResult) => {
            if (err) return res.send("Error");

            const t = tiffinResult[0];

            const totalAmount =
                (t.totalTiffin || 0) * 70 +
                (t.totalRoti || 0) * 10 +
                (t.totalBhakari || 0) * 10;

            const totalPaid = paymentResult[0].totalPaid || 0;

            res.json({
                totalTiffin: t.totalTiffin || 0,
                extraRoti: t.totalRoti || 0,
                extraBhakari: t.totalBhakari || 0,
                totalAmount,
                totalPaid,
                pending: totalAmount - totalPaid
            });
        });
    });
});

// SERVER (ONLY ONCE)
app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});
