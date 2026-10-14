require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET_KEY = process.env.PAYPAL_SECRET_KEY;
const PAYPAL_BASE_URL = "https://api-m.paypal.com";
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
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
  
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const app = express();
app.use(cors());
app.use(express.json());
app.post("/admin/login", (req, res) => {
  const { email, password } = req.body;

  if (!JWT_SECRET || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    return res.status(500).json({
      success: false,
      message: "Admin access is not configured."
    });
  }

  if (
    email?.trim().toLowerCase() !== ADMIN_EMAIL.trim().toLowerCase() ||
    password !== ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      success: false,
      message: "Invalid admin credentials."
    });
  }

  const token = jwt.sign(
    { role: "Admin", email: ADMIN_EMAIL },
    JWT_SECRET,
    { expiresIn: "2h" }
  );

  res.json({
    success: true,
    token
  });
});
function requireAdmin(req, res, next) {
  if (!JWT_SECRET) {
    return res.status(500).json({
      success: false,
      message: "Admin security is not configured."
    });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Admin authorization required."
    });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    if (payload.role !== "Admin") {
      return res.status(403).json({
        success: false,
        message: "Admin access required."
      });
    }

    req.admin = payload;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired admin token."
    });
  }
}
function requireUser(req, res, next) {
  if (!JWT_SECRET) {
    return res.status(500).json({
      success: false,
      message: "User security is not configured."
    });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "User authorization required."
    });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    if (
      !payload.userId ||
      !["Customer", "Driver", "Merchant"].includes(payload.role)
    ) {
      return res.status(403).json({
        success: false,
        message: "User access required."
      });
    }

    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired user token."
    });
  }
}
async function requireApprovedWorker(req, res, next) {
  try {
    if (!req.user?.userId) {
      return res.status(401).json({
        success: false,
        message: "User authorization required."
      });
    }

    const result = await pool.query(
      `SELECT role, verification_status
       FROM users
       WHERE id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User account not found."
      });
    }

    const account = result.rows[0];

    if (!["Driver", "Merchant"].includes(account.role)) {
      return res.status(403).json({
        success: false,
        message: "Worker access required."
      });
    }

    if (account.verification_status !== "approved") {
      return res.status(403).json({
        success: false,
        verificationOnly: true,
        message: "Your account is limited to verification until admin approval."
      });
    }
if (account.role === "Driver") {
  const requiredDocumentTypes = [
    "driver_license",
    "ssn_verification",
    "vehicle_insurance",
    "vehicle_registration"
  ];

  const documentsResult = await pool.query(
    `SELECT
       COUNT(DISTINCT document_type)::int AS required_found,
       COUNT(*) FILTER (
         WHERE status <> 'approved'
       )::int AS not_approved,
       COUNT(*) FILTER (
         WHERE expires_at IS NOT NULL
           AND expires_at < CURRENT_DATE
       )::int AS expired
     FROM verification_documents
     WHERE user_id = $1
       AND document_type = ANY($2::text[])`,
    [req.user.userId, requiredDocumentTypes]
  );

  const docs = documentsResult.rows[0];

  if (
    docs.required_found !== requiredDocumentTypes.length ||
    docs.not_approved > 0 ||
    docs.expired > 0
  ) {
    return res.status(403).json({
      success: false,
      verificationOnly: true,
      message:
        "Driver access is paused until all required documents are approved and valid."
    });
  }
}
    req.worker = account;
    next();
  } catch (error) {
    console.error("Worker authorization error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to verify worker access."
    });
  }
}
app.get("/auth/me", requireUser, (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.user.userId,
      email: req.user.email,
      role: req.user.role
    }
  });
});
const verificationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "application/pdf",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only JPG, PNG, or PDF files are allowed."));
    }
    cb(null, true);
  },
});

app.post(
  "/verification/upload",
  requireUser,
  verificationUpload.single("document"),
  async (req, res) => {
    try {
      if (!["Driver", "Merchant"].includes(req.user.role)) {
        return res.status(403).json({
          success: false,
          message: "Only Driver or Merchant can upload documents.",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "No document provided.",
        });
      }

      const extension = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "application/pdf": "pdf",
      }[req.file.mimetype];

      const filePath =
        `${req.user.userId}/${Date.now()}-${crypto.randomUUID()}.${extension}`;

      const { data, error } = await supabase.storage
        .from("mayko-verification-documents")
        .upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        });

      if (error) throw error;

      return res.status(201).json({
        success: true,
        documentUrl: data.path,
      });
    } catch (error) {
      console.error("Document upload error:", error.message);
      return res.status(500).json({
        success: false,
        message: "Document upload failed.",
      });
    }
  }
);
app.post("/verification/documents", requireUser, async (req, res) => {
  try {
    const { documentType, documentUrl, last4, expiresAt } = req.body;

    if (!["Driver", "Merchant"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Verification documents are only for Driver or Merchant accounts."
      });
    }

    if (!documentType) {
      return res.status(400).json({
        success: false,
        message: "Document type is required."
      });
    }

    if (last4 && !/^\d{4}$/.test(last4)) {
      return res.status(400).json({
        success: false,
        message: "Only the last 4 digits are allowed."
      });
    }

    const result = await pool.query(
      `INSERT INTO verification_documents
       (user_id, document_type, document_url, last4, status, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, NOW())
       ON CONFLICT (user_id, document_type)
       DO UPDATE SET
         document_url = EXCLUDED.document_url,
         last4 = EXCLUDED.last4,
         status = 'pending',
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()
       RETURNING id, user_id, document_type, status, expires_at`,
      [
        req.user.userId,
        documentType,
        documentUrl || null,
        last4 || null,
        expiresAt || null
      ]
    );

    res.status(201).json({
      success: true,
      document: result.rows[0]
    });
  } catch (error) {
    console.error("Verification document error:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to save verification document."
    });
  }
});
app.get("/admin/pending-users", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, full_name, email, role, verification_status, created_at
      FROM users
      WHERE role IN ('Driver', 'Merchant')
        AND verification_status = 'pending'
      ORDER BY created_at ASC
    `);

    res.json({
      success: true,
      users: result.rows
    });
  } catch (error) {
    console.error("Pending users error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to load pending users."
    });
  }
});
app.get("/admin/users/:id/documents", requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid user ID."
    });
  }

  try {
    const userResult = await pool.query(
      `SELECT id, full_name, email, role, verification_status
       FROM users
       WHERE id = $1
         AND role IN ('Driver', 'Merchant')`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Driver or Merchant not found."
      });
    }

    const documentsResult = await pool.query(
      `SELECT
         id,
         document_type,
         document_url,
         last4,
         status,
         expires_at,
         created_at,
         updated_at
       FROM verification_documents
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [userId]
    );

    res.json({
      success: true,
      user: userResult.rows[0],
      documents: documentsResult.rows
    });
  } catch (error) {
    console.error("Admin documents error:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to load verification documents."
    });
  }
});
app.patch("/admin/documents/:id/status", requireAdmin, async (req, res) => {
  const documentId = Number(req.params.id);
  const { status } = req.body;

  if (!Number.isInteger(documentId) || documentId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid document ID."
    });
  }

  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Status must be approved or rejected."
    });
  }

  try {
    const documentResult = await pool.query(
      `SELECT
         id,
         user_id,
         document_type,
         status,
         expires_at,
         (expires_at IS NOT NULL AND expires_at < CURRENT_DATE) AS expired
       FROM verification_documents
       WHERE id = $1`,
      [documentId]
    );

    if (documentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Verification document not found."
      });
    }

    const document = documentResult.rows[0];

    if (status === "approved" && document.expired) {
      return res.status(409).json({
        success: false,
        message: "Expired documents cannot be approved."
      });
    }

    const result = await pool.query(
      `UPDATE verification_documents
       SET status = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING id, user_id, document_type, status, expires_at, updated_at`,
      [status, documentId]
    );

    res.json({
      success: true,
      document: result.rows[0]
    });
  } catch (error) {
    console.error("Document status error:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to update verification document."
    });
  }
});
app.patch("/admin/users/:id/approve", requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid user ID."
    });
  }

  try {
   const userCheck = await pool.query(
  `SELECT role
   FROM users
   WHERE id = $1
     AND role IN ('Driver', 'Merchant')
     AND verification_status = 'pending'`,
  [userId]
);

if (userCheck.rows.length === 0) {
  return res.status(404).json({
    success: false,
    message: "Pending Driver or Merchant not found."
  });
}

const role = userCheck.rows[0].role;

const requiredDocumentTypes =
  role === "Driver"
    ? [
        "driver_license",
        "ssn_verification",
        "vehicle_insurance",
        "vehicle_registration"
      ]
    : [
        "business_document",
        "ein_verification"
      ];

const documentCheck = await pool.query(
  `SELECT
     COUNT(DISTINCT document_type)::int AS required_found,
     COUNT(*) FILTER (WHERE status <> 'approved')::int AS not_approved,
     COUNT(*) FILTER (
       WHERE expires_at IS NOT NULL
         AND expires_at < CURRENT_DATE
     )::int AS expired
   FROM verification_documents
   WHERE user_id = $1
     AND document_type = ANY($2::text[])`,
  [userId, requiredDocumentTypes]
);

const docs = documentCheck.rows[0];

if (
  docs.required_found !== requiredDocumentTypes.length ||
  docs.not_approved > 0 ||
  docs.expired > 0
) {
  return res.status(409).json({
    success: false,
    message:
      "All required verification documents must be present, approved, and valid."
  });
}
    const result = await pool.query(
      `UPDATE users
       SET verification_status = 'approved'
       WHERE id = $1
         AND role IN ('Driver', 'Merchant')
         AND verification_status = 'pending'
       RETURNING id, full_name, email, role, verification_status`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Pending Driver or Merchant not found."
      });
    }

    res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    console.error("Approve user error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to approve user."
    });
  }
});
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

app.get("/geocode", requireUser, async (req, res) => {
  const address =
    typeof req.query.address === "string"
      ? req.query.address.trim()
      : "";

  if (!address) {
    return res.status(400).json({
      success: false,
      message: "Address is required."
    });
  }

  try {
    const url =
      `https://nominatim.openstreetmap.org/search` +
      `?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(address)}`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "MaykoDelivery/1.0",
        "Accept": "application/json",
        "Accept-Language": "en"
      }
    });

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        message: "Geocoding service unavailable."
      });
    }

    const results = await response.json();

    if (!Array.isArray(results) || results.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Address not found."
      });
    }

    const lat = Number(results[0].lat);
    const lng = Number(results[0].lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(502).json({
        success: false,
        message: "Invalid coordinates received."
      });
    }

    res.json({
      success: true,
      address: results[0].display_name || address,
      lat,
      lng
    });
  } catch (error) {
    console.error("Geocode error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to geocode address."
    });
  }
});
app.post("/delivery-request", requireUser, async (req, res) => {
  if (req.user.role !== "Customer") {
    return res.status(403).json({
      success: false,
      message: "Only Customer accounts can create delivery requests."
    });
  }

  const {
    pickup,
    destination,
    pickupLat,
    pickupLng,
    destinationLat,
    destinationLng
  } = req.body;

  if (
    typeof pickup !== "string" ||
    typeof destination !== "string" ||
    !pickup.trim() ||
    !destination.trim()
  ) {
    return res.status(400).json({
      success: false,
      message: "Pickup and destination are required."
    });
  }

  const coordinates = [
    pickupLat,
    pickupLng,
    destinationLat,
    destinationLng
  ].map(Number);

  if (coordinates.some(value => !Number.isFinite(value))) {
    return res.status(400).json({
      success: false,
      message: "Valid pickup and destination coordinates are required."
    });
  }

  const [
    pickupLatitude,
    pickupLongitude,
    destinationLatitude,
    destinationLongitude
  ] = coordinates;

  const toRadians = degrees => degrees * (Math.PI / 180);
  const earthRadiusMiles = 3958.8;

  const latDifference = toRadians(
    destinationLatitude - pickupLatitude
  );

  const lngDifference = toRadians(
    destinationLongitude - pickupLongitude
  );

  const a =
    Math.sin(latDifference / 2) ** 2 +
    Math.cos(toRadians(pickupLatitude)) *
      Math.cos(toRadians(destinationLatitude)) *
      Math.sin(lngDifference / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const distanceMiles = Number(
    (earthRadiusMiles * c).toFixed(2)
  );

  const basePrice = 5;
  const pricePerMile = 2;

  const estimatedPrice = Number(
    (basePrice + distanceMiles * pricePerMile).toFixed(2)
  );

  try {
    const result = await pool.query(
      `INSERT INTO deliveries
       (
         customer_id,
         pickup_address,
         destination_address,
         pickup_lat,
         pickup_lng,
         destination_lat,
         destination_lng,
         distance_miles,
         estimated_price,
         status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
       RETURNING
         id,
         customer_id,
         pickup_address,
         destination_address,
         pickup_lat,
         pickup_lng,
         destination_lat,
         destination_lng,
         distance_miles,
         estimated_price,
         status,
         created_at`,
      [
        req.user.userId,
        pickup.trim(),
        destination.trim(),
        pickupLatitude,
        pickupLongitude,
        destinationLatitude,
        destinationLongitude,
        distanceMiles,
        estimatedPrice
      ]
    );

    res.status(201).json({
      success: true,
      message: "Delivery request created.",
      delivery: result.rows[0]
    });
  } catch (error) {
    console.error("Delivery request error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to create delivery request."
    });
  }
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
    await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS verification_status
    TEXT DEFAULT 'pending'
  `);
     await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS business_name TEXT
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS business_address TEXT
  `);
  await pool.query(`
  ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_online BOOLEAN NOT NULL DEFAULT FALSE
`);
  await pool.query(`

    CREATE TABLE IF NOT EXISTS verification_documents (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_type TEXT NOT NULL,
      document_url TEXT,
      last4 TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, document_type)
    )
  `);
    await pool.query(`
    ALTER TABLE verification_documents
    ADD COLUMN IF NOT EXISTS expires_at DATE
  `);
  await pool.query(`
  CREATE TABLE IF NOT EXISTS deliveries (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    driver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    pickup_address TEXT NOT NULL,
    destination_address TEXT NOT NULL,
    pickup_lat DOUBLE PRECISION,
    pickup_lng DOUBLE PRECISION,
    destination_lat DOUBLE PRECISION,
    destination_lng DOUBLE PRECISION,
    distance_miles NUMERIC(10, 2),
    estimated_price NUMERIC(10, 2),
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`);
await pool.query(`
  ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS driver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS destination_address TEXT,
  ADD COLUMN IF NOT EXISTS pickup_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS pickup_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS destination_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS destination_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS distance_miles NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS estimated_price NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
`);
}

ensureUsersTable().catch(console.error);

app.post("/auth/register", async (req, res) => {
  const { fullName, email, password, role = "Customer", businessName, businessAddress } = req.body;

  if (!fullName || !email || !password) {
    return res.status(400).json({
      success: false,
      message: "Please complete all fields."
    });
  }
const allowedRoles = ["Customer", "Driver", "Merchant"];

if (!allowedRoles.includes(role)) {
  return res.status(400).json({
    success: false,
    message: "Invalid account type."
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
      (full_name, email, password_hash, password_salt, role, verification_status, business_name, business_address)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'Customer' THEN 'approved' ELSE 'pending' END, $6, $7)
     RETURNING id, full_name, email, role, verification_status`,
      [fullName.trim(), normalizedEmail, passwordHash, salt, role, businessName || null, businessAddress || null]
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
app.delete("/auth/account", requireUser, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await pool.query(
      `DELETE FROM users
       WHERE id = $1
       RETURNING id`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Account not found."
      });
    }

    res.json({
      success: true,
      message: "Account deleted successfully."
    });
  } catch (error) {
    console.error("Delete account error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to delete account."
    });
  }
});
app.post("/driver/status", requireUser, async (req, res) => {
  if (req.user.role !== "Driver") {
    return res.status(403).json({
      success: false,
      message: "Driver access only."
    });
  }

  const { isOnline } = req.body;

  if (typeof isOnline !== "boolean") {
    return res.status(400).json({
      success: false,
      message: "isOnline must be true or false."
    });
  }

  try {
    await pool.query(
      "UPDATE users SET is_online = $1 WHERE id = $2",
      [isOnline, req.user.userId]
    );

    return res.json({ success: true, isOnline });
  } catch (error) {
    console.error("Driver status error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to update driver status."
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
      `SELECT id, full_name, email, password_hash, password_salt, role, verification_status
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
    const verificationOnly =
  ['Driver', 'Merchant'].includes(user.role) &&
  user.verification_status !== 'approved';
        const token = jwt.sign(
      {
        userId: user.id,
        role: user.role,
        email: user.email
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({
      success: true,
      token,
      verificationOnly,
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
    