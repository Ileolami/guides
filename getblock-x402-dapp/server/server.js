import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import axios from "axios";
import "dotenv/config";

// ES Module directory resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// =============================================================================
// CORS Configuration
// =============================================================================
// x402 uses custom headers for payment data, so we need to expose them
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-PAYMENT",
      "X-Payment",
      "x-payment",
    ],
    exposedHeaders: [
      "X-PAYMENT-RESPONSE",
      "X-Payment-Response",
      "x-payment-response",
      "X-PAYMENT-REQUIRED",
      "X-Payment-Required",
      "x-payment-required",
    ],
  })
);

app.use(express.json());

// =============================================================================
// Request Logging (for debugging)
// =============================================================================
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);

  const paymentHeader = req.headers["x-payment"] || req.headers["X-PAYMENT"];
  if (paymentHeader) {
    console.log("  Payment header present (length:", paymentHeader.length, ")");
  }

  next();
});

// =============================================================================
// Configuration
// =============================================================================
const payTo = process.env.PAYMENT_WALLET_ADDRESS;
const GETBLOCK_API_KEY = process.env.GETBLOCK_API_KEY;
const GETBLOCK_URL = GETBLOCK_API_KEY
  ? `https://go.getblock.io/${GETBLOCK_API_KEY}`
  : null;

console.log("\n📋 Configuration:");
console.log(`   Payment wallet: ${payTo}`);
console.log(
  `   GetBlock API: ${
    GETBLOCK_API_KEY ? "Configured" : "Not configured (using mock data)"
  }`
);

// Validate required config
if (!payTo) {
  console.error("❌ Missing PAYMENT_WALLET_ADDRESS in .env");
  process.exit(1);
}

// =============================================================================
// GetBlock API Helper
// =============================================================================
async function callGetBlock(method, params = []) {
  // If no API key, return mock data for demo purposes
  if (!GETBLOCK_URL) {
    console.log("  Using mock data (no GetBlock API key)");
    if (method === "eth_blockNumber") {
      const mockBlock = Math.floor(Date.now() / 1000);
      return { result: "0x" + mockBlock.toString(16) };
    }
    if (method === "eth_gasPrice") {
      return { result: "0x" + (20 * 1e9).toString(16) }; // 20 Gwei
    }
    return { result: null };
  }

  // Call GetBlock API
  try {
    const response = await axios.post(GETBLOCK_URL, {
      jsonrpc: "2.0",
      id: "getblock",
      method,
      params,
    });
    return response.data;
  } catch (error) {
    console.error("  GetBlock API error:", error.message);
    throw error;
  }
}

// =============================================================================
// x402 Setup
// =============================================================================

// Initialize the facilitator client
// The facilitator verifies payment signatures and settles transactions
const facilitatorUrl = "https://facilitator.payai.network";
console.log(`   Facilitator: ${facilitatorUrl}`);

const facilitatorClient = new HTTPFacilitatorClient({
  url: facilitatorUrl,
});

// Create the resource server and register the EVM payment scheme
const server = new x402ResourceServer(facilitatorClient);
registerExactEvmScheme(server);

// =============================================================================
// Payment Route Configuration
// =============================================================================
// Define which routes require payment and how much they cost
const paymentConfig = {
  "GET /api/eth/block/latest": {
    accepts: [
      {
        scheme: "exact", // Payment scheme (exact amount)
        price: "$0.001", // Price in USD
        network: "eip155:84532", // Base Sepolia (CAIP-2 format)
        payTo, // Your wallet address
      },
    ],
    description: "Get latest Ethereum block number",
    mimeType: "application/json",
  },

  "GET /api/eth/gas": {
    accepts: [
      {
        scheme: "exact",
        price: "$0.001",
        network: "eip155:84532",
        payTo,
      },
    ],
    description: "Get current gas price",
    mimeType: "application/json",
  },
};

// Apply the payment middleware
// This intercepts requests to protected routes and verifies payment
app.use(paymentMiddleware(paymentConfig, server));

// =============================================================================
// Static Files & Routes
// =============================================================================

// Serve the frontend
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

// Free endpoint: API information
app.get("/api", (req, res) => {
  res.json({
    message: "GetBlock x402 API",
    version: "1.0.0",
    network: "Base Sepolia (eip155:84532)",
    facilitator: facilitatorUrl,
    payTo,
    endpoints: [
      {
        path: "/api/eth/block/latest",
        price: "$0.001 USDC",
        description: "Get latest Ethereum block number",
      },
      {
        path: "/api/eth/gas",
        price: "$0.001 USDC",
        description: "Get current gas price",
      },
    ],
  });
});

// =============================================================================
// Protected Endpoints (require payment)
// =============================================================================

// Get latest block number
app.get("/api/eth/block/latest", async (req, res) => {
  console.log("  ✓ Payment verified - serving block data");
  try {
    const result = await callGetBlock("eth_blockNumber");
    res.json({
      blockNumber: result.result,
      decimal: parseInt(result.result, 16),
      timestamp: new Date().toISOString(),
      source: GETBLOCK_URL ? "getblock" : "mock",
    });
  } catch (error) {
    console.error("  Error fetching block number:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get current gas price
app.get("/api/eth/gas", async (req, res) => {
  console.log("  ✓ Payment verified - serving gas data");
  try {
    const result = await callGetBlock("eth_gasPrice");
    const gasPriceWei = BigInt(result.result);
    res.json({
      gasPriceWei: result.result,
      gasPriceGwei: (Number(gasPriceWei) / 1e9).toFixed(2),
      timestamp: new Date().toISOString(),
      source: GETBLOCK_URL ? "getblock" : "mock",
    });
  } catch (error) {
    console.error("  Error fetching gas price:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// Error Handling
// =============================================================================
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: err.message });
});

// =============================================================================
// Start Server
// =============================================================================
const PORT = process.env.PORT || 4021;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log("Protected endpoints:");
  Object.entries(paymentConfig).forEach(([route, config]) => {
    console.log(`   ${route} - ${config.accepts[0].price} USDC`);
  });
});
