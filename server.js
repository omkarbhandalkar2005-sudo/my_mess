// server.js
const express = require('express');
const cors = require('cors');  // CORS middleware
const app = express();

// ✅ Middleware
app.use(cors());            // frontend se cross-origin requests allow kare
app.use(express.json());    // JSON body parse karne ke liye

// 🔥 Add Tiffin route
app.post('/add-tiffin', (req, res) => {
    console.log(req.body);  // frontend se aaya hua data terminal me dikhega
    res.send('Tiffin added successfully 🍱');
});

// ✅ Start backend
app.listen(3000, () => {
    console.log('Backend running on http://localhost:3000');
});