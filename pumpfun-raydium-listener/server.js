import { Connection, PublicKey } from "@solana/web3.js";
import WebSocket from "ws";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Configuration
const WS_ENDPOINT = process.env.GETBLOCK_WS_ENDPOINT;
const HTTP_ENDPOINT = process.env.GETBLOCK_HTTP_ENDPOINT;
const MIGRATION_ACCOUNT = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
const RAYDIUM_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// Validate configuration
if (!WS_ENDPOINT || !HTTP_ENDPOINT) {
  console.error("❌ Missing required environment variables");
  console.error(
    "Please set GETBLOCK_WS_ENDPOINT and GETBLOCK_HTTP_ENDPOINT in .env file"
  );
  process.exit(1);
}

console.log("✅ Configuration loaded successfully");

class PumpFunMigrationListener {
  constructor() {
    this.ws = null;
    this.connection = new Connection(HTTP_ENDPOINT, "confirmed");
    this.subscriptionId = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.raydiumMigrationCount = 0;
    this.pumpswapMigrationCount = 0;
    this.migrations = [];
    this.startTime = Date.now();
    this.totalLogsReceived = 0;
  }

  start() {
    console.log("🚀 Starting Pump.fun Migration Listener...");
    console.log("📡 Monitoring account:", MIGRATION_ACCOUNT);
    console.log("🎯 Tracking: Raydium + PumpSwap migrations");
    console.log("");
    this.connect();
    this.checkRunning();
  }

  checkRunning() {
    setInterval(() => {
      const runtime = Math.floor((Date.now() - this.startTime) / 1000);
      const hours = Math.floor(runtime / 3600);
      const minutes = Math.floor((runtime % 3600) / 60);
      const seconds = runtime % 60;

      console.log(
        `💓 Alive | Runtime: ${hours}h ${minutes}m ${seconds}s | Logs: ${this.totalLogsReceived} | Raydium: ${this.raydiumMigrationCount} | PumpSwap: ${this.pumpswapMigrationCount}`
      );
    }, 60000);
  }
  connect() {
    console.log("🔌 Connecting to GetBlock WebSocket...");
    this.ws = new WebSocket(WS_ENDPOINT);

    this.ws.on("open", () => this.handleOpen());
    this.ws.on("message", (data) => this.handleMessage(data));
    this.ws.on("error", (error) => this.handleError(error));
    this.ws.on("close", () => this.handleClose());
  }

  handleOpen() {
    console.log("✅ Connected to GetBlock WebSocket");
    this.isConnected = true;
    this.reconnectAttempts = 0;
    this.subscribeToLogs();
  }
  subscribeToLogs() {
    const subscribeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        {
          mentions: [MIGRATION_ACCOUNT],
        },
        {
          commitment: "confirmed",
        },
      ],
    };

    console.log("📡 Subscribing to migration events...");
    this.ws.send(JSON.stringify(subscribeRequest));
  }
  async handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());

      if (message.result && !message.params) {
        this.subscriptionId = message.result;
        console.log(`✅ Subscribed with ID: ${this.subscriptionId}`);
        console.log("⏳ Listening for migrations...\n");
        return;
      }

      if (message.params && message.params.result) {
        await this.processLog(message.params.result);
      }
    } catch (error) {
      console.error("❌ Error handling message:", error.message);
    }
  }
  async processLog(result) {
    const { value } = result;
    this.totalLogsReceived++;

    console.log(
      `📨 Log #${this.totalLogsReceived} - TX: ${value.signature.substring(
        0,
        20
      )}...`
    );

    if (value.err) {
      console.log("   ↳ Skipped (failed transaction)");
      return;
    }

    const hasMigration = value.logs.some(
      (log) =>
        log.includes("Instruction: Migrate") ||
        log.includes("migrate") ||
        log.includes("initialize2")
    );

    if (hasMigration) {
      console.log("   ↳ 🎯 MIGRATION DETECTED!");
      await this.fetchAndProcessTransaction(value.signature);
    } else {
      console.log("   ↳ Not a migration");
    }
  }
  async fetchAndProcessTransaction(signature) {
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });

      if (!tx) {
        console.log("⚠️  Transaction not found, skipping...");
        return;
      }

      const migrationData = this.extractMigrationData(tx, signature);

      if (migrationData) {
        this.migrations.push(migrationData);

        if (migrationData.type === "raydium") {
          this.raydiumMigrationCount++;
        } else if (migrationData.type === "pumpswap") {
          this.pumpswapMigrationCount++;
        }

        this.displayMigration(migrationData);
      }
    } catch (error) {
      console.error("❌ Error fetching transaction:", error.message);
    }
  }
  extractMigrationData(tx, signature) {
    try {
      let accountKeys, instructions;

      if (tx.transaction.message.addressTableLookups) {
        accountKeys =
          tx.transaction.message.staticAccountKeys ||
          tx.transaction.message.accountKeys;
        instructions =
          tx.transaction.message.compiledInstructions ||
          tx.transaction.message.instructions;
      } else {
        accountKeys = tx.transaction.message.accountKeys;
        instructions = tx.transaction.message.instructions;
      }

      if (!Array.isArray(instructions)) {
        instructions = Object.values(instructions);
      }

      for (const instruction of instructions) {
        let programId;

        if (instruction.programIdIndex !== undefined) {
          programId = accountKeys[instruction.programIdIndex];
        } else if (instruction.programId) {
          programId = instruction.programId;
        }

        // Check for Raydium migration
        if (programId && programId.toString() === RAYDIUM_PROGRAM) {
          const accounts = instruction.accounts;

          if (!accounts || accounts.length < 7) continue;

          return {
            type: "raydium",
            signature: signature,
            slot: tx.slot,
            blockTime: tx.blockTime,
            poolAddress: accountKeys[accounts[1]].toString(),
            tokenAddress: accountKeys[accounts[5]].toString(),
            quoteMint: accountKeys[accounts[6]].toString(),
            lpMint: accountKeys[accounts[4]].toString(),
          };
        }

        // Check for PumpSwap migration
        if (programId && programId.toString() === PUMPFUN_PROGRAM) {
          return {
            type: "pumpswap",
            signature: signature,
            slot: tx.slot,
            blockTime: tx.blockTime,
            tokenAddress: accountKeys[2]
              ? accountKeys[2].toString()
              : "Unknown",
            bondingCurve: accountKeys[1]
              ? accountKeys[1].toString()
              : "Unknown",
            destination: "PumpSwap",
          };
        }
      }
    } catch (error) {
      console.error("❌ Error extracting migration data:", error.message);
    }

    return null;
  }
  displayMigration(data) {
    if (data.type === "raydium") {
      console.log("\n🚀 ═══════════════════════════════════════════════════");
      console.log("   NEW PUMP.FUN → RAYDIUM MIGRATION DETECTED!");
      console.log("═══════════════════════════════════════════════════\n");
      console.log(`Migration #${this.raydiumMigrationCount} (Raydium)\n`);
      console.log(`📊 Token Address:  ${data.tokenAddress}`);
      console.log(`🏊 Pool Address:   ${data.poolAddress}`);
      console.log(`💧 LP Mint:        ${data.lpMint}`);
      console.log(`💰 Quote Token:    ${data.quoteMint}\n`);
      console.log(`📝 Transaction:    ${data.signature}`);
      console.log(`🔢 Slot:           ${data.slot}`);

      if (data.blockTime) {
        console.log(
          `⏰ Time:           ${new Date(data.blockTime * 1000).toISOString()}`
        );
      }

      console.log(`\n🔗 View on Solscan:`);
      console.log(`   https://solscan.io/tx/${data.signature}\n`);
      console.log(`🔗 Trade on Raydium:`);
      console.log(
        `   https://raydium.io/swap/?inputMint=sol&outputMint=${data.tokenAddress}\n`
      );
      console.log("═══════════════════════════════════════════════════\n");
    } else if (data.type === "pumpswap") {
      console.log("\n💧 ═══════════════════════════════════════════════════");
      console.log("   NEW PUMP.FUN → PUMPSWAP MIGRATION DETECTED!");
      console.log("═══════════════════════════════════════════════════\n");
      console.log(`Migration #${this.pumpswapMigrationCount} (PumpSwap)\n`);
      console.log(`📊 Token Address:      ${data.tokenAddress}`);
      console.log(`🎯 Bonding Curve:      ${data.bondingCurve}`);
      console.log(`🏪 Destination:        ${data.destination}\n`);
      console.log(`📝 Transaction:        ${data.signature}`);
      console.log(`🔢 Slot:               ${data.slot}`);

      if (data.blockTime) {
        console.log(
          `⏰ Time:               ${new Date(
            data.blockTime * 1000
          ).toISOString()}`
        );
      }

      console.log(`\n🔗 View on Solscan:`);
      console.log(`   https://solscan.io/tx/${data.signature}\n`);
      console.log(`🔗 View Token:`);
      console.log(`   https://pump.fun/${data.tokenAddress}\n`);
      console.log("═══════════════════════════════════════════════════\n");
    }
  }
  handleError(error) {
    console.error("❌ WebSocket error:", error.message);
  }

  handleClose() {
    this.isConnected = false;
    console.log("🔌 Connection closed");

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

      console.log(
        `🔄 Reconnecting in ${delay / 1000}s (attempt ${
          this.reconnectAttempts
        }/${this.maxReconnectAttempts})...`
      );

      setTimeout(() => {
        this.connect();
      }, delay);
    } else {
      console.error("❌ Max reconnection attempts reached. Exiting...");
      process.exit(1);
    }
  }

  stop() {
    console.log("👋 Stopping listener...");
    if (this.ws) {
      this.ws.close();
    }
  }
}

const listener = new PumpFunMigrationListener();
listener.start();

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  listener.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  listener.stop();
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  console.error("💥 Uncaught exception:", error);
  listener.stop();
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error("💥 Unhandled rejection:", error);
  listener.stop();
  process.exit(1);
});