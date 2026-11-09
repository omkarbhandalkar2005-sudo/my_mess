require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcrypt');
const https      = require('https');
const crypto     = require('crypto');
const jwt        = require('jsonwebtoken');
const app        = express();
const db         = require('./db');

// Razorpay client — Order banane ke liye
const Razorpay = require('razorpay');
const razorpay = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Web Push setup — VAPID keys Render ke Environment se aati hain
const webpush = require('web-push');
let pushEnabled = false;
try {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
        webpush.setVapidDetails(
            process.env.VAPID_SUBJECT,
            process.env.VAPID_PUBLIC_KEY,
            process.env.VAPID_PRIVATE_KEY
        );
        pushEnabled = true;
        console.log("🔔 Web Push configured");
    } else {
        console.warn("⚠️ Web Push disabled: VAPID env vars missing");
    }
} catch (err) {
    console.error("⚠️ Web Push disabled: invalid VAPID keys", err.message);
}

app.use(cors());
app.use(express.json({
    // Razorpay's webhook signature is computed over the exact raw bytes
    // of the request body, so we stash them here before body-parsing
    // turns req.body into a JS object.
    verify: (req, res, buf) => { req.rawBody = buf; }
}));

// ---------- AUTH MIDDLEWARE ----------
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.warn("⚠️ JWT_SECRET missing — auth tokens disabled");
}

function requireAuth(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token || !JWT_SECRET) {
        return res.status(401).json({ message: "Login required" });
    }
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (e) {
        return res.status(401).json({ message: "Session expired, please login again" });
    }
}

function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: "Admin only" });
        }
        next();
    });
}

// Allows the request only if the logged-in user owns the data (their id matches
// the given params/body field) or is an admin.
function requireOwner(source, field) {
    return (req, res, next) => {
        requireAuth(req, res, () => {
            if (req.user.role === 'admin') return next();
            const target = (req[source] || {})[field];
            if (String(req.user.id) !== String(target)) {
                return res.status(403).json({ message: "Not allowed" });
            }
            next();
        });
    };
}

const TIFFIN_PRICE  = 70;
const FAST_PRICE    = 50;
const CHAPATI_PRICE       = 10;   // chapati taken WITH a tiffin
const CHAPATI_ALONE_PRICE = 15;   // chapati taken WITHOUT a tiffin (quantity = 0 that day)
const BHAKARI_PRICE       = 10;   // bhakari taken WITH a tiffin
const BHAKARI_ALONE_PRICE = 20;   // bhakari taken WITHOUT a tiffin (quantity = 0 that day)

const otpStore      = {};
const resetOtpStore = {};

// Server runs on UTC time (Railway), so this helper converts to IST (India) date/day
function getIST() {
    const now        = new Date();
    const utcMs      = now.getTime() + (now.getTimezoneOffset() * 60000);
    const istMs       = utcMs + (5.5 * 60 * 60000);
    const ist        = new Date(istMs);
    const days       = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const yyyy       = ist.getFullYear();
    const mm         = String(ist.getMonth() + 1).padStart(2, '0');
    const dd         = String(ist.getDate()).padStart(2, '0');

    return { date: `${yyyy}-${mm}-${dd}`, day: days[ist.getDay()] };
}

// Send email via Brevo API
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

// ============================================================
// WEB PUSH HELPERS
// Sab "fire and forget" hain: push fail ho toh bhi booking/menu ka
// kaam kabhi nahi rukta, bas console mein error print hota hai.
// ============================================================

// Ek subscription (ek phone/browser) ko push bhejo
function sendPushToSubscription(sub, payload) {
    if (!pushEnabled) return;

    const subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
    };

    webpush.sendNotification(subscription, JSON.stringify(payload)).catch((err) => {
        // 404/410 = phone ne subscription cancel kar di ya expire ho gayi → DB se hata do
        if (err.statusCode === 404 || err.statusCode === 410) {
            db.query("DELETE FROM push_subscriptions WHERE id = ?", [sub.id], (delErr) => {
                if (delErr) console.error("Push cleanup failed:", delErr.message);
            });
        } else {
            console.error("Push send failed:", err.statusCode || "", err.message);
        }
    });
}

// Ek customer ke saare phones ko
function pushToCustomer(customerId, payload) {
    if (!pushEnabled) return;
    db.query("SELECT * FROM push_subscriptions WHERE customer_id = ?", [customerId], (err, rows) => {
        if (err) return console.error("Push lookup failed:", err.message);
        rows.forEach(sub => sendPushToSubscription(sub, payload));
    });
}

// Saare admins ko
function pushToAdmins(payload) {
    if (!pushEnabled) return;
    const sql = `SELECT s.* FROM push_subscriptions s
                 JOIN customers c ON c.id = s.customer_id
                 WHERE LOWER(TRIM(c.role)) = 'admin'`;
    db.query(sql, (err, rows) => {
        if (err) return console.error("Push lookup failed:", err.message);
        rows.forEach(sub => sendPushToSubscription(sub, payload));
    });
}

// Saare customers ko (admin ko nahi)
function pushToAllCustomers(payload) {
    if (!pushEnabled) return;
    const sql = `SELECT s.* FROM push_subscriptions s
                 JOIN customers c ON c.id = s.customer_id
                 WHERE LOWER(TRIM(COALESCE(c.role, 'customer'))) <> 'admin'`;
    db.query(sql, (err, rows) => {
        if (err) return console.error("Push lookup failed:", err.message);
        rows.forEach(sub => sendPushToSubscription(sub, payload));
    });
}

// Naya booking aaya → admin ko batao (customer ka naam DB se nikalke)
function notifyAdminsNewBooking(customerId, mealType, foodType) {
    if (!pushEnabled) return;
    db.query("SELECT name FROM customers WHERE id = ?", [customerId], (err, rows) => {
        const name = (!err && rows.length > 0) ? rows[0].name : "A customer";
        pushToAdmins({
            title: "🍱 New booking request",
            body:  `${name} booked ${mealType} (${foodType})`,
            url:   "/home.html"
        });
    });
}

// Customer ne Razorpay se payment ki → admin ko batao
function notifyAdminsOnlinePayment(customerId, amount) {
    if (!pushEnabled) return;
    db.query("SELECT name FROM customers WHERE id = ?", [customerId], (err, rows) => {
        const name = (!err && rows.length > 0) ? rows[0].name : "A customer";
        pushToAdmins({
            title: "💰 Payment received",
            body:  `${name} paid ₹${amount}`,
            url:   "/home.html"
        });
    });
}

// ============================================================
// PENDING BILL REMINDERS
// cron-job.org tay dates par is route ko call karta hai (header mein secret ke saath)
// ============================================================
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November", "December"];

app.post('/cron/bill-reminders', (req, res) => {
    const secret   = process.env.CRON_SECRET;
    const provided = req.headers['x-cron-secret'];

    // Secret match nahi hua toh koi bhi isse chala nahi sakta
    if (!secret || !provided ||
        provided.length !== secret.length ||
        !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret))) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    // Reminder sirf PICHLE mahine ke bill ka jayega (IST ke hisaab se)
    const nowIST    = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    let prevMonth   = nowIST.getUTCMonth();          // current month (0-11) = pichle mahine ka number (1-12)
    let prevYear    = nowIST.getUTCFullYear();
    if (prevMonth === 0) { prevMonth = 12; prevYear -= 1; }
    const monthName = MONTH_NAMES[prevMonth - 1];

    const customersSql = `SELECT id FROM customers WHERE role = 'customer'`;

    // Har customer ke har mahine ka bill (Bill Summary jaisa hi)
    const monthlySql = `SELECT customer_id, YEAR(date) AS y, MONTH(date) AS m,
                               SUM(CASE WHEN type = 'Fast' THEN quantity ELSE 0 END) AS fastTiffin,
                               SUM(CASE WHEN type != 'Fast' THEN quantity ELSE 0 END) AS regularTiffin,
                               SUM(CASE WHEN quantity > 0 THEN extra_roti ELSE 0 END) AS chapatiWithTiffin,
                               SUM(CASE WHEN quantity = 0 THEN extra_roti ELSE 0 END) AS chapatiAlone,
                               SUM(CASE WHEN quantity > 0 THEN extra_bhakari ELSE 0 END) AS bhakariWithTiffin,
                               SUM(CASE WHEN quantity = 0 THEN extra_bhakari ELSE 0 END) AS bhakariAlone
                        FROM tiffin
                        GROUP BY customer_id, YEAR(date), MONTH(date)
                        ORDER BY customer_id ASC, y ASC, m ASC`;

    const paymentsSql = `SELECT customer_id, SUM(amount_paid) AS totalPaid FROM payments GROUP BY customer_id`;

    db.query(customersSql, (err, customers) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error fetching customers" });
        }

        db.query(monthlySql, (err, monthlyRows) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: "Error fetching tiffin data" });
            }

            db.query(paymentsSql, (err, paymentRows) => {
                if (err) {
                    console.error(err);
                    return res.status(500).json({ message: "Error fetching payment data" });
                }

                const rowsByCustomer = {};
                monthlyRows.forEach(r => {
                    (rowsByCustomer[r.customer_id] = rowsByCustomer[r.customer_id] || []).push(r);
                });

                const paidByCustomer = {};
                paymentRows.forEach(r => { paidByCustomer[r.customer_id] = Number(r.totalPaid) || 0; });

                let withPending = 0;
                customers.forEach((c) => {
                    // Bill Summary jaisa hi FIFO hisaab: payment sabse purane mahine se adjust hoti hai
                    const ledger = buildMonthlyLedger(rowsByCustomer[c.id] || [], paidByCustomer[c.id] || 0);
                    const entry  = ledger.get(`${prevYear}-${prevMonth}`);
                    const pending = entry ? Math.round(Number(entry.pending)) : 0;

                    if (pending >= 1) {
                        withPending++;
                        pushToCustomer(c.id, {
                            title: "💳 Pending bill reminder",
                            body:  `Your ${monthName} mess bill of ₹${pending} is pending. Please pay soon.`,
                            url:   "/customers-info.html"
                        });
                    }
                });

                console.log(`⏰ Bill reminders for ${monthName} ${prevYear}: ${withPending} of ${customers.length} customers have pending dues`);
                return res.status(200).json({ month: `${monthName} ${prevYear}`, checked: customers.length, withPending });
            });
        });
    });
});

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
        return res.status(400).json({ message: "Please request an OTP first" });
    }

    if (Date.now() > stored.expiry) {
        delete otpStore[email];
        return res.status(400).json({ message: "OTP has expired, please request a new one" });
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

            const userRole = String(result[0].role || "customer").toLowerCase().trim();
            const token = JWT_SECRET
                ? jwt.sign({ id: result[0].id, role: userRole }, JWT_SECRET, { expiresIn: '30d' })
                : null;

            return res.status(200).json({
                message:    "Login successful",
                token:      token,
                role:       userRole,
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

        // Security: return the same message whether the email exists or not, so no one can
        // figure out which emails are registered. OTP is only sent if the email actually exists.
        if (result.length === 0) {
            return res.status(200).json({ message: "If this email is registered, an OTP has been sent ✅" });
        }

        const otp    = Math.floor(100000 + Math.random() * 900000).toString();
        const expiry = Date.now() + 5 * 60 * 1000;

        resetOtpStore[email] = { otp, expiry };

        const html = `
            <h2>Mess Tracker - Password Reset</h2>
            <p>Your OTP to reset your password is:</p>
            <h1 style="color: #4CAF50; letter-spacing: 5px;">${otp}</h1>
            <p>This OTP will expire in 5 minutes.</p>
            <p>If you did not request this, please ignore this email.</p>
        `;

        sendEmail(email, "Mess Tracker - Password Reset OTP", html, (err) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: "Error sending OTP" });
            }
            return res.status(200).json({ message: "If this email is registered, an OTP has been sent ✅" });
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
        return res.status(400).json({ message: "Please request an OTP first" });
    }

    if (Date.now() > stored.expiry) {
        delete resetOtpStore[email];
        return res.status(400).json({ message: "OTP has expired, please request a new one" });
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

// CUSTOMER DIRECTORY (id + name + contact, for the searchable customer
// selector used across Add Tiffin, Record Payment, Bill Summary and
// Activity History, and for the admin-only Customers Info page). Reuses
// the same role='customer' filter as /api/monthly-summary, just without
// the billing joins. `contact` was added for Customers Info — existing
// consumers only ever read `id`/`name`, so this is additive and safe.
app.get('/api/customers', requireAdmin, (req, res) => {
    db.query("SELECT id, name, contact FROM customers WHERE role = 'customer' ORDER BY id ASC", (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error fetching customers" });
        }
        res.status(200).json(result);
    });
});

// TIFFIN LIST FOR A GIVEN DATE (used on Add Tiffin page to show "who has
// taken a tiffin today" — same data as tiffin-history, just grouped by
// date instead of by customer, with the customer name joined in).
app.get('/tiffin-by-date/:date', requireAdmin, (req, res) => {
    const sql = `SELECT t.id, t.customer_id, c.name, t.type, t.quantity, t.extra_roti, t.extra_bhakari
                 FROM tiffin t
                 JOIN customers c ON c.id = t.customer_id
                 WHERE t.date = ?
                 ORDER BY c.name ASC`;

    db.query(sql, [req.params.date], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error fetching tiffin list" });
        }

        res.json(result);
    });
});

// ADD TIFFIN
app.post('/add-tiffin', requireAdmin, (req, res) => {
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
app.post('/add-payment', requireAdmin, (req, res) => {
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

// CREATE RAZORPAY ORDER (called when customer taps "Pay Now")
app.post('/create-razorpay-order', requireOwner('body', 'customer_id'), (req, res) => {
    const { customer_id, amount } = req.body;

    if (!customer_id || !amount) {
        return res.status(400).json({ message: "customer_id and amount are required" });
    }

    const options = {
        amount:   Math.round(amount * 100), // Razorpay takes amount in paise (₹1 = 100)
        currency: "INR",
        receipt:  `receipt_${customer_id}_${Date.now()}`,
        notes: {
            customer_id: String(customer_id) // webhook isse padhega payment record karne ke liye
        }
    };

    razorpay.orders.create(options, (err, order) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error creating Razorpay order" });
        }

        res.status(200).json({
            order_id: order.id,
            amount:   order.amount,
            currency: order.currency,
            key_id:   process.env.RAZORPAY_KEY_ID
        });
    });
});

// RAZORPAY WEBHOOK — Razorpay's server calls this when a payment is
// captured. This automatically records the customer's payment in the
// `payments` table, so the admin doesn't have to do it manually.
app.post('/razorpay-webhook', (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    const secret    = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!signature || !secret || !req.rawBody) {
        return res.status(400).json({ message: "Missing signature or webhook not configured" });
    }

    // Verify signature — confirms this request genuinely came from
    // Razorpay and wasn't a fake call from someone else
    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(req.rawBody)
        .digest('hex');

    const sigMatches = signature.length === expectedSignature.length &&
        crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));

    if (!sigMatches) {
        console.error('❌ Razorpay webhook: signature mismatch');
        return res.status(400).json({ message: "Invalid signature" });
    }

    const event = req.body.event;

    // Only react to successful payment events, ignore the rest (but return 200,
    // otherwise Razorpay will keep retrying)
    if (event !== 'payment.captured') {
        return res.status(200).json({ status: "ignored", event });
    }

    const payment           = req.body.payload.payment.entity;
    const razorpayPaymentId = payment.id;
    const customerId        = payment.notes && payment.notes.customer_id;
    const amountPaid        = payment.amount / 100; // paise -> rupees

    if (!customerId) {
        console.error('⚠️ Razorpay webhook: payment.captured without customer_id in notes', razorpayPaymentId);
        return res.status(200).json({ status: "ignored_no_customer_id" });
    }

    // Idempotency check — Razorpay can send the same webhook multiple times
    // (retries), so we must check to avoid inserting duplicates
    const checkSql = `SELECT id FROM payments WHERE razorpay_payment_id = ?`;

    db.query(checkSql, [razorpayPaymentId], (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "DB error while checking payment" });
        }

        if (rows.length > 0) {
            return res.status(200).json({ status: "already_recorded" });
        }

        const { date } = getIST();
        const insertSql = `INSERT INTO payments (customer_id, amount_paid, date, razorpay_payment_id, source)
                            VALUES (?, ?, ?, ?, 'razorpay')`;

        db.query(insertSql, [customerId, amountPaid, date, razorpayPaymentId], (err2) => {
            if (err2) {
                console.error(err2);
                return res.status(500).json({ message: "Error recording payment" });
            }

            console.log(`✅ Razorpay payment auto-recorded: customer ${customerId}, ₹${amountPaid}`);
            res.status(200).json({ status: "recorded" });
            notifyAdminsOnlinePayment(customerId, amountPaid);
            return;
        });
    });
});

// TIFFIN HISTORY
app.get('/tiffin-history/:id', requireOwner('params', 'id'), (req, res) => {
    const { month, year } = req.query;
    const hasFilter = month && year;

    const sql = `SELECT id, date, type, quantity, extra_roti, extra_bhakari
                 FROM tiffin WHERE customer_id = ?
                 ${hasFilter ? 'AND MONTH(date) = ? AND YEAR(date) = ?' : ''}
                 ORDER BY date DESC`;

    const params = hasFilter ? [req.params.id, month, year] : [req.params.id];

    db.query(sql, params, (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error fetching tiffin history" });
        }

        res.json(result);
    });
});

// DELETE TIFFIN
app.delete('/tiffin/:id', requireAdmin, (req, res) => {
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
app.get('/payment-history/:id', requireOwner('params', 'id'), (req, res) => {
    const { month, year } = req.query;
    const hasFilter = month && year;

    const sql = `SELECT date, amount_paid
                 FROM payments WHERE customer_id = ?
                 ${hasFilter ? 'AND MONTH(date) = ? AND YEAR(date) = ?' : ''}
                 ORDER BY date DESC`;

    const params = hasFilter ? [req.params.id, month, year] : [req.params.id];

    db.query(sql, params, (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error fetching payment history" });
        }

        res.json(result);
    });
});

// ============================================================
// PAYMENT ALLOCATION (FIFO — oldest unpaid month gets cleared first)
// ============================================================
// A payment is NOT tied to the month it was paid in. Instead every
// payment a customer has ever made goes into one pool, and that pool
// is walked across their bills oldest-month-first until it runs out.
// This is recalculated fresh on every request (nothing is stored),
// so editing or deleting a tiffin entry later automatically keeps
// every month's paid/pending numbers correct — no stale data possible.
function buildMonthlyLedger(monthlyRows, totalPaidPool) {
    let remaining = Number(totalPaidPool) || 0;
    const ledger = new Map();

    monthlyRows.forEach(row => {
        const totalTiffin  = Number(row.fastTiffin || 0) + Number(row.regularTiffin || 0);
        const totalChapati = Number(row.chapatiWithTiffin || 0) + Number(row.chapatiAlone || 0);
        const totalAmount =
            (row.regularTiffin     || 0) * TIFFIN_PRICE        +
            (row.fastTiffin        || 0) * FAST_PRICE          +
            (row.chapatiWithTiffin || 0) * CHAPATI_PRICE       +
            (row.chapatiAlone      || 0) * CHAPATI_ALONE_PRICE +
            (row.bhakariWithTiffin || 0) * BHAKARI_PRICE       +
            (row.bhakariAlone      || 0) * BHAKARI_ALONE_PRICE;

        const paid    = Math.min(remaining, totalAmount);
        const pending = totalAmount - paid;
        remaining -= paid;

        ledger.set(`${row.y}-${row.m}`, {
            totalTiffin,
            extraChapati:    totalChapati,
            extraBhakari: Number(row.bhakariWithTiffin || 0) + Number(row.bhakariAlone || 0),
            totalAmount,
            paid,
            pending
        });
    });

    return ledger;
}

// FINAL BILL
app.get('/final-bill/:id', requireOwner('params', 'id'), (req, res) => {
    const id = req.params.id;
    const { month, year } = req.query;
    const hasFilter = month && year;

    // No month/year given -> simple all-time totals. Unchanged: with no
    // month bucket to allocate into, "total paid" is just every rupee
    // the customer has ever paid, and pending can go negative (credit).
    if (!hasFilter) {
        const tiffinSql = `SELECT
                                  SUM(CASE WHEN type = 'Fast' THEN quantity ELSE 0 END) AS fastTiffin,
                                  SUM(CASE WHEN type != 'Fast' THEN quantity ELSE 0 END) AS regularTiffin,
                                  SUM(CASE WHEN quantity > 0 THEN extra_roti ELSE 0 END) AS chapatiWithTiffin,
                                  SUM(CASE WHEN quantity = 0 THEN extra_roti ELSE 0 END) AS chapatiAlone,
                                  SUM(CASE WHEN quantity > 0 THEN extra_bhakari ELSE 0 END) AS bhakariWithTiffin,
                                  SUM(CASE WHEN quantity = 0 THEN extra_bhakari ELSE 0 END) AS bhakariAlone
                           FROM tiffin WHERE customer_id = ?`;

        const paymentSql = `SELECT SUM(amount_paid) AS totalPaid FROM payments WHERE customer_id = ?`;

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
                const totalTiffin  = Number(t.fastTiffin || 0) + Number(t.regularTiffin || 0);
                const totalChapati = Number(t.chapatiWithTiffin || 0) + Number(t.chapatiAlone || 0);

                const totalAmount =
                    (t.regularTiffin     || 0) * TIFFIN_PRICE        +
                    (t.fastTiffin        || 0) * FAST_PRICE          +
                    (t.chapatiWithTiffin || 0) * CHAPATI_PRICE       +
                    (t.chapatiAlone      || 0) * CHAPATI_ALONE_PRICE +
                    (t.bhakariWithTiffin || 0) * BHAKARI_PRICE       +
                    (t.bhakariAlone      || 0) * BHAKARI_ALONE_PRICE;

                const totalPaid = paymentResult[0].totalPaid || 0;
                const pending   = totalAmount - totalPaid;

                res.status(200).json({
                    totalTiffin,
                    extraChapati:    totalChapati,
                    extraBhakari: Number(t.bhakariWithTiffin || 0) + Number(t.bhakariAlone || 0),
                    totalAmount,
                    totalPaid,
                    pending,
                    status: pending <= 0 ? "Paid ✅" : "Pending ❌"
                });
            });
        });
        return;
    }

    // Month/year given -> FIFO allocation. We pull EVERY month this
    // customer has bills for (not just the requested one) plus their
    // all-time payment total, walk oldest-to-newest, then read off
    // just the requested month's paid/pending from that walk.
    const monthlyTiffinSql = `SELECT YEAR(date) AS y, MONTH(date) AS m,
                                      SUM(CASE WHEN type = 'Fast' THEN quantity ELSE 0 END) AS fastTiffin,
                                      SUM(CASE WHEN type != 'Fast' THEN quantity ELSE 0 END) AS regularTiffin,
                                      SUM(CASE WHEN quantity > 0 THEN extra_roti ELSE 0 END) AS chapatiWithTiffin,
                                      SUM(CASE WHEN quantity = 0 THEN extra_roti ELSE 0 END) AS chapatiAlone,
                                      SUM(CASE WHEN quantity > 0 THEN extra_bhakari ELSE 0 END) AS bhakariWithTiffin,
                                      SUM(CASE WHEN quantity = 0 THEN extra_bhakari ELSE 0 END) AS bhakariAlone
                               FROM tiffin
                               WHERE customer_id = ?
                               GROUP BY YEAR(date), MONTH(date)
                               ORDER BY y ASC, m ASC`;

    const totalPaidSql = `SELECT SUM(amount_paid) AS totalPaid FROM payments WHERE customer_id = ?`;

    db.query(monthlyTiffinSql, [id], (err, monthlyRows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error calculating bill" });
        }

        db.query(totalPaidSql, [id], (err, paymentResult) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: "Error calculating payment" });
            }

            const totalPaidPool = paymentResult[0].totalPaid || 0;
            const ledger = buildMonthlyLedger(monthlyRows, totalPaidPool);
            const entry  = ledger.get(`${Number(year)}-${Number(month)}`) || {
                totalTiffin: 0, extraChapati: 0, extraBhakari: 0, totalAmount: 0, paid: 0, pending: 0
            };

            res.status(200).json({
                totalTiffin:  entry.totalTiffin,
                extraChapati:    entry.extraChapati,
                extraBhakari: entry.extraBhakari,
                totalAmount:  entry.totalAmount,
                totalPaid:    entry.paid,
                pending:      entry.pending,
                status: entry.pending <= 0 ? "Paid ✅" : "Pending ❌"
            });
        });
    });
});

// ALL CUSTOMERS SUMMARY (Admin list — name, id, total tiffins, total bill)
app.get('/api/monthly-summary', requireAdmin, (req, res) => {
    const { month, year } = req.query;
    const hasFilter = month && year;

    const customersSql = `SELECT id, name FROM customers WHERE role = 'customer' ORDER BY id ASC`;

    // No month/year given -> simple all-time totals per customer (unchanged)
    if (!hasFilter) {
        const tiffinSql = `SELECT customer_id,
                                  SUM(CASE WHEN type = 'Fast' THEN quantity ELSE 0 END) AS fastTiffin,
                                  SUM(CASE WHEN type != 'Fast' THEN quantity ELSE 0 END) AS regularTiffin,
                                  SUM(CASE WHEN quantity > 0 THEN extra_roti ELSE 0 END) AS chapatiWithTiffin,
                                  SUM(CASE WHEN quantity = 0 THEN extra_roti ELSE 0 END) AS chapatiAlone,
                                  SUM(CASE WHEN quantity > 0 THEN extra_bhakari ELSE 0 END) AS bhakariWithTiffin,
                                  SUM(CASE WHEN quantity = 0 THEN extra_bhakari ELSE 0 END) AS bhakariAlone
                           FROM tiffin
                           GROUP BY customer_id`;

        const paymentSql = `SELECT customer_id, SUM(amount_paid) AS totalPaid
                            FROM payments
                            GROUP BY customer_id`;

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

                    const summary = customers
                        .map(c => {
                            const t = tiffinMap[c.id] || {};
                            const totalTiffin = Number(t.fastTiffin || 0) + Number(t.regularTiffin || 0);

                            const totalAmount =
                                (t.regularTiffin     || 0) * TIFFIN_PRICE        +
                                (t.fastTiffin        || 0) * FAST_PRICE          +
                                (t.chapatiWithTiffin || 0) * CHAPATI_PRICE       +
                                (t.chapatiAlone      || 0) * CHAPATI_ALONE_PRICE +
                                (t.bhakariWithTiffin || 0) * BHAKARI_PRICE       +
                                (t.bhakariAlone      || 0) * BHAKARI_ALONE_PRICE;

                            const totalPaid = paymentMap[c.id] || 0;
                            const pending   = totalAmount - totalPaid;

                            return { id: c.id, name: c.name, totalTiffin, totalAmount, totalPaid, pending };
                        })
                        // Customers with no tiffins at all shouldn't clutter the list
                        .filter(row => row.totalTiffin > 0);

                    res.status(200).json(summary);
                });
            });
        });
        return;
    }

    // Month/year given -> FIFO allocation per customer. Pull EVERY
    // month each customer has bills for plus their all-time payment
    // total, walk oldest-to-newest per customer, then read off the
    // requested month's paid/pending.
    const monthlyTiffinSql = `SELECT customer_id, YEAR(date) AS y, MONTH(date) AS m,
                                      SUM(CASE WHEN type = 'Fast' THEN quantity ELSE 0 END) AS fastTiffin,
                                      SUM(CASE WHEN type != 'Fast' THEN quantity ELSE 0 END) AS regularTiffin,
                                      SUM(CASE WHEN quantity > 0 THEN extra_roti ELSE 0 END) AS chapatiWithTiffin,
                                      SUM(CASE WHEN quantity = 0 THEN extra_roti ELSE 0 END) AS chapatiAlone,
                                      SUM(CASE WHEN quantity > 0 THEN extra_bhakari ELSE 0 END) AS bhakariWithTiffin,
                                      SUM(CASE WHEN quantity = 0 THEN extra_bhakari ELSE 0 END) AS bhakariAlone
                               FROM tiffin
                               GROUP BY customer_id, YEAR(date), MONTH(date)
                               ORDER BY customer_id ASC, y ASC, m ASC`;

    const totalPaidSql = `SELECT customer_id, SUM(amount_paid) AS totalPaid
                          FROM payments
                          GROUP BY customer_id`;

    db.query(customersSql, (err, customers) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error fetching customers" });
        }

        db.query(monthlyTiffinSql, (err, monthlyRows) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: "Error fetching tiffin data" });
            }

            db.query(totalPaidSql, (err, paymentRows) => {
                if (err) {
                    console.error(err);
                    return res.status(500).json({ message: "Error fetching payment data" });
                }

                const rowsByCustomer = {};
                monthlyRows.forEach(row => {
                    if (!rowsByCustomer[row.customer_id]) rowsByCustomer[row.customer_id] = [];
                    rowsByCustomer[row.customer_id].push(row);
                });

                const paidPoolMap = {};
                paymentRows.forEach(row => { paidPoolMap[row.customer_id] = row.totalPaid || 0; });

                const key = `${Number(year)}-${Number(month)}`;

                const summary = customers
                    .map(c => {
                        const ledger = buildMonthlyLedger(rowsByCustomer[c.id] || [], paidPoolMap[c.id] || 0);
                        const entry  = ledger.get(key) || {
                            totalTiffin: 0, extraChapati: 0, extraBhakari: 0, totalAmount: 0, paid: 0, pending: 0
                        };

                        return {
                            id: c.id,
                            name: c.name,
                            totalTiffin: entry.totalTiffin,
                            totalAmount: entry.totalAmount,
                            totalPaid:   entry.paid,
                            pending:     entry.pending
                        };
                    })
                    // Customers with no tiffins in the selected month shouldn't clutter the list
                    .filter(row => row.totalTiffin > 0);

                res.status(200).json(summary);
            });
        });
    });
});

// ============================================================
// WEB PUSH ROUTES
// ============================================================

// Frontend ko public key chahiye subscribe karne ke liye (public hai, safe hai)
app.get('/push/public-key', (req, res) => {
    if (!pushEnabled) {
        return res.status(503).json({ message: "Push notifications not available" });
    }
    res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Phone ki subscription save karo (same phone dobara aaye toh update ho jayegi)
app.post('/push/subscribe', requireOwner('body', 'customer_id'), (req, res) => {
    const { customer_id, subscription } = req.body;

    if (!customer_id || !subscription || !subscription.endpoint ||
        !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
        return res.status(400).json({ message: "Invalid subscription" });
    }

    const sql = `INSERT INTO push_subscriptions (customer_id, endpoint, p256dh, auth)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE customer_id = VALUES(customer_id), p256dh = VALUES(p256dh), auth = VALUES(auth)`;

    db.query(sql, [customer_id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error saving subscription" });
        }
        return res.status(200).json({ message: "Notifications enabled ✅" });
    });
});

// turn off Notifications
app.post('/push/unsubscribe', requireAuth, (req, res) => {
    const { endpoint } = req.body;

    if (!endpoint) {
        return res.status(400).json({ message: "Endpoint required" });
    }

    db.query("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error removing subscription" });
        }
        return res.status(200).json({ message: "Notifications disabled" });
    });
});

// ============================================================
// TODAY'S MEAL BOOKING SYSTEM
// ============================================================

// GET today's menu + this customer's booking status for Lunch & Dinner
app.get('/menu/today/:customer_id', requireOwner('params', 'customer_id'), (req, res) => {
    const { date, day } = getIST();
    const customerId = req.params.customer_id;

    db.query("SELECT meal_type, veg_menu_text, nonveg_menu_text, meal_time FROM daily_menus WHERE day_of_week = ?", [day], (err, menuRows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error fetching menu" });
        }

        db.query(
            "SELECT id, meal_type, status, selected_food_type FROM bookings WHERE customer_id = ? AND booking_date = ?",
            [customerId, date],
            (err, bookingRows) => {
                if (err) {
                    console.error(err);
                    return res.status(500).json({ message: "Error fetching bookings" });
                }

                const menuMap = {};
                menuRows.forEach(r => { menuMap[r.meal_type] = r; });

                const bookingMap = {};
                bookingRows.forEach(r => { bookingMap[r.meal_type] = r; });

                const result = { date, day };

                ["Lunch", "Dinner"].forEach(meal => {
                    const m = menuMap[meal] || {};
                    const b = bookingMap[meal] || null;
                    result[meal.toLowerCase()] = {
                        veg_menu_text: m.veg_menu_text || null,
                        nonveg_menu_text: m.nonveg_menu_text || null,
                        meal_time: m.meal_time || null,
                        status: b ? b.status : null,
                        selected_food_type: b ? b.selected_food_type : null
                    };
                });

                res.status(200).json(result);
            }
        );
    });
});

// CUSTOMER: Book a tiffin for today (Lunch/Dinner)
app.post('/bookings', requireOwner('body', 'customer_id'), (req, res) => {
    const { customer_id, meal_type, selected_food_type } = req.body;

    if (!customer_id || !meal_type) {
        return res.status(400).json({ message: "Customer ID and meal type are required" });
    }

    if (!["Lunch", "Dinner"].includes(meal_type)) {
        return res.status(400).json({ message: "Invalid meal type" });
    }

    const foodType = selected_food_type || "Veg";

    // Extras: negative ya galat value aaye toh 0 maan lo
    const extraRoti    = Math.max(0, parseInt(req.body.extra_roti, 10)    || 0);
    const extraBhakari = Math.max(0, parseInt(req.body.extra_bhakari, 10) || 0);

    if (!["Veg", "Non-Veg"].includes(foodType)) {
        return res.status(400).json({ message: "Invalid food type" });
    }

    const { date } = getIST();

    db.query(
        "SELECT id, status FROM bookings WHERE customer_id = ? AND booking_date = ? AND meal_type = ?",
        [customer_id, date, meal_type],
        (err, rows) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: "Server error" });
            }

            if (rows.length > 0) {
                const existing = rows[0];

                if (existing.status === 'pending' || existing.status === 'approved') {
                    return res.status(409).json({ message: "Already requested for today" });
                }

                // Purani rejected booking thi, use pending pe reset kar do (rebook)
                db.query(
                    "UPDATE bookings SET status = 'pending', selected_food_type = ?, extra_roti = ?, extra_bhakari = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?",
                    [foodType, extraRoti, extraBhakari, existing.id],
                    (err) => {
                        if (err) {
                            console.error(err);
                            return res.status(500).json({ message: "Error creating booking" });
                        }
                        res.status(200).json({ message: "Booking request sent ✅" });
                        notifyAdminsNewBooking(customer_id, meal_type, foodType);
                        return;
                    }
                );
                return;
            }

            db.query(
                "INSERT INTO bookings (customer_id, booking_date, meal_type, status, selected_food_type, extra_roti, extra_bhakari) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
                [customer_id, date, meal_type, foodType, extraRoti, extraBhakari],
                (err) => {
                    if (err) {
                        console.error(err);
                        return res.status(500).json({ message: "Error creating booking" });
                    }
                    res.status(201).json({ message: "Booking request sent ✅" });
                    notifyAdminsNewBooking(customer_id, meal_type, foodType);
                    return;
                }
            );
        }
    );
});

// ADMIN: Get today's booking requests (all customers)
app.get('/admin/bookings/today', requireAdmin, (req, res) => {
    const { date } = getIST();

    const sql = `SELECT b.id, b.customer_id, c.name, b.meal_type, b.selected_food_type, b.extra_roti, b.extra_bhakari, b.status, b.created_at
                 FROM bookings b
                 JOIN customers c ON c.id = b.customer_id
                 WHERE b.booking_date = ?
                 ORDER BY b.created_at ASC`;

    db.query(sql, [date], (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error fetching bookings" });
        }
        res.status(200).json(rows);
    });
});

// ADMIN: Approve a booking (also adds it to the customer's bill)
app.post('/admin/bookings/:id/approve', requireAdmin, (req, res) => {
    const bookingId = req.params.id;

    db.query("SELECT * FROM bookings WHERE id = ?", [bookingId], (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Server error" });
        }

        if (rows.length === 0) {
            return res.status(404).json({ message: "Booking not found" });
        }

        const booking = rows[0];

        if (booking.status === 'approved') {
            return res.status(400).json({ message: "Already approved" });
        }

        db.query("UPDATE bookings SET status = 'approved' WHERE id = ?", [bookingId], (err) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: "Error approving booking" });
            }

            // Billing mein bhi add kar do (existing tiffin table use karke)
            const tiffinSql = `INSERT INTO tiffin (customer_id, date, type, quantity, extra_roti, extra_bhakari)
                               VALUES (?, ?, ?, 1, ?, ?)`;

            db.query(tiffinSql, [booking.customer_id, booking.booking_date, booking.selected_food_type, booking.extra_roti, booking.extra_bhakari], (err) => {
                if (err) {
                    console.error(err);
                    return res.status(500).json({ message: "Booking approved, but billing failed" });
                }
                res.status(200).json({ message: "Booking approved and added to bill ✅" });
                pushToCustomer(booking.customer_id, {
                    title: "✅ Booking approved",
                    body:  `Your ${booking.meal_type} tiffin (${booking.selected_food_type}) has been approved`,
                    url:   "/home.html"
                });
                return;
            });
        });
    });
});

// ADMIN: Reject a booking
app.post('/admin/bookings/:id/reject', requireAdmin, (req, res) => {
    db.query("UPDATE bookings SET status = 'rejected' WHERE id = ?", [req.params.id], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error rejecting booking" });
        }

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Booking not found" });
        }

        res.status(200).json({ message: "Booking rejected" });

        // Customer ko batane ke liye booking ki detail nikalo
        db.query("SELECT customer_id, meal_type FROM bookings WHERE id = ?", [req.params.id], (err, rows) => {
            if (err || rows.length === 0) return;
            pushToCustomer(rows[0].customer_id, {
                title: "❌ Booking rejected",
                body:  `Your ${rows[0].meal_type} booking was rejected`,
                url:   "/home.html"
            });
        });
    });
});

// ============================================================
// WEEKLY MENU MANAGEMENT (Admin)
// ============================================================

// GET full weekly menu (all days, Lunch + Dinner)
app.get('/admin/menu', requireAdmin, (req, res) => {
    db.query("SELECT day_of_week, meal_type, veg_menu_text, nonveg_menu_text, meal_time FROM daily_menus", (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error fetching menu" });
        }
        res.status(200).json(rows);
    });
});

// UPDATE (or create) a single day+meal's menu and timing
app.put('/admin/menu', requireAdmin, (req, res) => {
    const { day_of_week, meal_type, veg_menu_text, nonveg_menu_text, meal_time } = req.body;

    if (!day_of_week || !meal_type) {
        return res.status(400).json({ message: "Day and meal type are required" });
    }

    if (!veg_menu_text) {
        return res.status(400).json({ message: "Veg menu is required" });
    }

    const sql = `INSERT INTO daily_menus (day_of_week, meal_type, veg_menu_text, nonveg_menu_text, meal_time)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE veg_menu_text = VALUES(veg_menu_text), nonveg_menu_text = VALUES(nonveg_menu_text), meal_time = VALUES(meal_time)`;

    // Look at the old menu first, so the push only goes out on a real change
    db.query(
        "SELECT veg_menu_text, nonveg_menu_text FROM daily_menus WHERE day_of_week = ? AND meal_type = ?",
        [day_of_week, meal_type],
        (selErr, oldRows) => {
            const norm = (v) => (v || '').toString().trim();
            const menuChanged = Boolean(selErr) || oldRows.length === 0 ||
                norm(oldRows[0].veg_menu_text)    !== norm(veg_menu_text) ||
                norm(oldRows[0].nonveg_menu_text) !== norm(nonveg_menu_text);

            db.query(sql, [day_of_week, meal_type, veg_menu_text || '', nonveg_menu_text || null, meal_time || null], (err) => {
                if (err) {
                    console.error(err);
                    return res.status(500).json({ message: "Error saving menu" });
                }
                res.status(200).json({ message: "Menu updated ✅" });

                if (menuChanged) {
                    const menuPreview = String(veg_menu_text).slice(0, 100);
                    pushToAllCustomers({
                        title: `🍽️ ${day_of_week} ${meal_type} menu updated`,
                        body:  menuPreview,
                        url:   "/home.html"
                    });
                }
                return;
            });
        }
    );
});

// SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});