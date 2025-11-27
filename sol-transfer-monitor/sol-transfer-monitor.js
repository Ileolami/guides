import Client from "@triton-one/yellowstone-grpc";
import { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import bs58 from "bs58";
import { config } from "dotenv";
config();

const ENDPOINT = "https://go.getblock.io";  // Your region's endpoint
const TOKEN = "process.env.GETBLOCK_TOKEN";           // Your generated token

// System Program (handles all native SOL transfers)
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// Minimum transfer amount in SOL to alert on
const MIN_TRANSFER_AMOUNT = 100; // 100 SOL threshold

// Statistics Tracking
let stats = {
  startTime: Date.now(),
  totalTransfers: 0,
  totalVolume: 0,
  largestTransfer: 0,
  largestTransferTx: null
};

function formatSOL(lamports) {
  return (lamports / 1_000_000_000).toFixed(4);
}

function displayTransfer(transferData) {
  stats.totalTransfers++;
  stats.totalVolume += transferData.amount;

  if (transferData.amount > stats.largestTransfer) {
    stats.largestTransfer = transferData.amount;
    stats.largestTransferTx = transferData.signature;
  }

  const solAmount = formatSOL(transferData.amount);

  console.log("\n" + "=".repeat(80));
  console.log(`HIGH VALUE TRANSFER #${stats.totalTransfers}`);
  console.log("=".repeat(80));

  console.log(`\nAMOUNT:      ${solAmount} SOL`);
  console.log(`FROM:        ${transferData.from}`);
  console.log(`TO:          ${transferData.to}`);
  console.log(`SIGNATURE:   ${transferData.signature}`);
  console.log(`SLOT:        ${transferData.slot}`);

  console.log(`\nEXPLORE:`);
  console.log(`   TX:     https://solscan.io/tx/${transferData.signature}`);
  console.log(`   From:   https://solscan.io/account/${transferData.from}`);
  console.log(`   To:     https://solscan.io/account/${transferData.to}`);

  console.log("\n" + "=".repeat(80) + "\n");
}

function parseTransferInstruction(instruction, accountKeys) {
  try {
    const data = Buffer.from(instruction.data);

    // System program transfer instruction has type 2
    // Data format: [4 bytes: instruction type (2)][8 bytes: lamports amount]
    if (data.length < 12) return null;

    const instructionType = data.readUInt32LE(0);
    if (instructionType !== 2) return null; // Not a transfer instruction

    const lamports = data.readBigUInt64LE(4);

    // Get from and to accounts
    const accountIndices = Array.from(instruction.accounts);
    if (accountIndices.length < 2) return null;

    const fromAccount = bs58.encode(
      Buffer.from(accountKeys[accountIndices[0]])
    );
    const toAccount = bs58.encode(Buffer.from(accountKeys[accountIndices[1]]));

    return {
      amount: Number(lamports),
      from: fromAccount,
      to: toAccount,
    };
  } catch (error) {
    return null;
  }
}

async function monitorHighValueTransfers() {
  console.log("Starting High Value SOL Transfer Monitor");
  console.log(`Minimum amount: ${MIN_TRANSFER_AMOUNT} SOL`);
  console.log(`Watching: Native SOL transfers\n`);
  console.log("Waiting for high value transfers...\n");

  return new Promise(async (resolve, reject) => {
    try {
      const client = new Client(ENDPOINT, TOKEN, undefined);
      const stream = await client.subscribe();

      const request = {
        accounts: {},
        slots: {},
        transactions: {
          sol_transfers: {
            accountInclude: [SYSTEM_PROGRAM],
            accountExclude: [],
            accountRequired: [],
          },
        },
        transactionsStatus: {},
        entry: {},
        blocks: {},
        blocksMeta: {},
        commitment: CommitmentLevel.CONFIRMED,
        accountsDataSlice: [],
        ping: undefined,
      };
      stream.on("data", (message) => {
        try {
          if (message.pong) {
            stream.write({ ping: { id: message.pong.id } });
            return;
          }

          if (
            message.transaction &&
            message.filters &&
            message.filters.includes("sol_transfers")
          ) {
            const tx = message.transaction.transaction;
            const signature = bs58.encode(tx.signature);
            const slot = message.transaction.slot.toString();

            const txMessage = tx.transaction.message;
            const accountKeys = txMessage.accountKeys;
            const instructions = txMessage.instructions;
            // Process each instruction
            for (const instruction of instructions) {
              const programIdx = instruction.programIdIndex;
              const programId = bs58.encode(accountKeys[programIdx]);

              // Only process System Program instructions
              if (programId !== SYSTEM_PROGRAM) continue;

              const transferData = parseTransferInstruction(
                instruction,
                accountKeys
              );

              if (!transferData) continue;

              // Check if transfer meets minimum threshold
              const solAmount = transferData.amount / 1_000_000_000;
              if (solAmount >= MIN_TRANSFER_AMOUNT) {
                displayTransfer({
                  ...transferData,
                  signature: signature,
                  slot: slot,
                });
              }
            }
          }
        } catch (error) {
          console.error(`Error processing transaction: ${error.message}`);
        }
      });
      stream.on("error", (error) => {
        console.error(`Stream error: ${error.message}`);
        reject(error);
      });

      stream.on("end", () => resolve());
      stream.on("close", () => resolve());
      stream.write(request, (err) => {
        if (err) {
          reject(err);
        } else {
          console.log("Subscription active - monitoring blockchain...\n");
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}
async function main() {
  try {
    await monitorHighValueTransfers();
  } catch (error) {
    console.error("Monitor crashed:", error.message);
    console.log("Restarting in 5 seconds...");
    setTimeout(main, 5000);
  }
}
process.on("SIGINT", () => {
  console.log("\n\nShutting down...");
  console.log(`\nTotal high value transfers: ${stats.totalTransfers}`);
  console.log(`Total volume: ${formatSOL(stats.totalVolume)} SOL`);
  console.log(`Largest transfer: ${formatSOL(stats.largestTransfer)} SOL`);
  if (stats.largestTransferTx) {
    console.log(`Largest TX: https://solscan.io/tx/${stats.largestTransferTx}`);
  }
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  console.log(`Uptime: ${Math.floor(uptime / 60)}m ${uptime % 60}s\n`);
  process.exit(0);
});

main();