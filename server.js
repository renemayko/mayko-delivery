require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { Pool } = require("pg");
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET_KEY = process.env.PAYPAL_SECRET_KEY;
const PAYPAL_BASE_URL = "https://api-m.paypal.com";
async function getPayPalAccessToken() {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET_KEY}`).toString("base64");
    const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${auth}`,
            },
            body: "grant_type=client_credentials",
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error_description || data.error || `PayPal error ${response.status}`);
            return data.access_token;
            }
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
    console.error("Stripe payment error:", error.message);
    res.status(500).json({ error: error.message });
}
});
app.post("/create-checkout-session", async (req, res) => {
    try {
        const { amount } = req.body;
        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        product_data: {
                            name: "Mayko Delivery",
                            },
                            unit_amount: Math.round(Number(amount) * 100),
                            },
                            quantity: 1,
                            },
                            ],
                            success_url: "bountiful-warmth-production.up.railway.app/payment-success",
                            cancel_url: "bountiful-warmth-production.up.railway.app/payment-cancel",
                            });
                            res.json({ url: session.url });
                            } catch (error) {
                                console.error(error);
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
app.get("/test-paypal", async (req, res) => {
    try {
        const token = await getPayPalAccessToken();
        res.json({ success: true, tokenReceived: !!token });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
            }
            });
            app.post("/paypal/create-order", async (req, res) => {
             try {
                const accessToken = await getPayPalAccessToken();
                const response = await fetch("https://api-m.paypal.com/v2/checkout/orders", {
                    method: "POST",
                 headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${accessToken}`,
                    },
                    body: JSON.stringify({
                        intent: "CAPTURE",
                        purchase_units: [
                            {
                                amount: {
                                    currency_code: "USD",
                                    value: req.body.amount,
                                    },
                                    }
                                    ],
                                    }),
                                    });
                                    const order = await response.json();
                                    const approveLink = order.links.find((link) => link.rel === "approve");
res.json({ url: approveLink.href, orderID: order.id });
                                    } catch (error) {
                                        console.error(error);
                                        res.status(500).json({ error: "PayPal order creation failed" });
                                      }
                                      });        
app.post("/paypal/capture-order/:orderID", async (req, res) => {
    try {
        const accessToken = await getPayPalAccessToken();
        const { orderID } = req.params;
        const response = await fetch(`https://api-m.paypal.com/v2/checkout/orders/${orderID}/capture`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
                },
                });
                const capture = await response.json();
                res.json(capture);
                } catch (error) {
                    console.error(error);
                    res.status(500).json({ error: "PayPal capture failed" });
                    }
                    });
                    app.get("/paypal/order-status/:orderID", async (req, res) => {
  try {
    const accessToken = await getPayPalAccessToken();
    const { orderID } = req.params;

    const response = await fetch(
      `https://api-m.paypal.com/v2/checkout/orders/${orderID}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const order = await response.json();
    res.status(response.status).json(order);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "PayPal order status failed" });
  }
});
                                      app.post("/delivery-request", async (req, res) => {
  console.log("Delivery request received:", req.body);
  res.status(201).json({
    success: true,
    message: "Delivery request received"
  });
});
app.get("/payment-success", (req, res) => {
  res.send("Payment successful - Mayko Delivery");
});
const crypto = require("crypto");

async function ensureUsersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Customer',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

ensureUsersTable().catch(console.error);

app.post("/auth/register", async (req, res) => {
  const { fullName, email, password, role = "Customer" } = req.body;

  if (!fullName || !email || !password) {
    return res.status(400).json({
      success: false,
      message: "Please complete all fields."
    });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto
    .scryptSync(password, salt, 64)
    .toString("hex");

  try {
    const result = await pool.query(
      `INSERT INTO users
       (full_name, email, password_hash, password_salt, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, full_name, email, role`,
      [fullName.trim(), normalizedEmail, passwordHash, salt, role]
    );

    res.status(201).json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "An account already exists with this email."
      });
    }

    console.error(error);
    res.status(500).json({
      success: false,
      message: "Unable to create account."
    });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: "Email and password are required."
    });
  }

  try {
    const result = await pool.query(
      `SELECT id, full_name, email, password_hash, password_salt, role
       FROM users
       WHERE email = $1`,
      [email.trim().toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    const user = result.rows[0];

    const enteredHash = crypto.scryptSync(
      password,
      user.password_salt,
      64
    );

    const savedHash = Buffer.from(user.password_hash, "hex");

    if (
      enteredHash.length !== savedHash.length ||
      !crypto.timingSafeEqual(enteredHash, savedHash)
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Unable to login."
    });
  }
});
app.listen(PORT, () => {
    console.log("Mayko Delivery API running on port " + PORT);
    });
    