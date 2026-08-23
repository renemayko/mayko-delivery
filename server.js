require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { Pool } = require("pg");
const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false },

});
pool.query("SELECT NOW()")
  .then(() => console.log("Database connected successfully"))
  .catch((error) => console.error("Database connection error:", error.message));
  pool.query(`CREATE TABLE IF NOT EXISTS deliveries (
  id SERIAL PRIMARY KEY,
  pickup_address TEXT NOT NULL,
  delivery_address TEXT NOT NULL,
  distance NUMERIC,
  delivery_price NUMERIC,
  merchant_sale NUMERIC,
  status TEXT DEFAULT 'available',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );`);  
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const app = express();
app.use(cors());
app.use(express.json());
app.get("/test-stripe", async (req, res) => {
try {
    const balance = await stripe.balance.retrieve();
res.json({ message: "Stripe connected successfully" });
} catch (error) {
    
    res.status(500).json({ error: error.message });        
}
});
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => {
res.send("Mayko Delivery API is running");    
});
app.post("/create-payment-intent", async (req, res) => {
    try {
        const { amount } = req.body;
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(Number(amount) * 100),
            currency: "usd",
            automatic_payment_methods: { enabled: true },
            });
            res.json({ clientSecret: paymentIntent.client_secret });
} catch (error) {
    res.status(500).json({ error: error.message });
}
});
app.get("/geocode", async (req, res) => {
 const address = req.query.address;
 if (!address) return res.status(400).json({ error: "Address required" });
 try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
    const response = await fetch(url, {
        headers: { "User-Agent": "MaykoDelivery/1.0" }
    });
    const data = await response.json();
    if (!data.length) return res.status(404).json({ error: "Address not found" });
res.json({ lat: Number(data[0].lat), lng: Number(data[0].lon) });
} catch (error) {
    res.status(500).json({ error: error.message });
}
});
app.get("/test-db", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW()");
        res.json({
            success: true,
            message: "Mayko Delivery database connected",
            time: result.rows[0].now
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log("Mayko Delivery API running on port " + PORT);
    });
    