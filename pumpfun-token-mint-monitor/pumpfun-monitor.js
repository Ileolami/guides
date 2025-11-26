import Client from "@triton-one/yellowstone-grpc";
import { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import bs58 from "bs58";
import { config } from "dotenv";

config();

const ENDPOINT =
  "https://go.getblock.io/";
const TOKEN = process.env.TOKEN;

const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);


let stats = {
  startTime: Date.now(),
  totalMints: 0,
  lastMintTime: null,
};


function decodeString(buffer, offset) {
  const length = buffer.readUInt32LE(offset);
  const str = buffer.slice(offset + 4, offset + 4 + length).toString("utf8");
  return { value: str, bytesRead: 4 + length };
}

function parseCreateInstruction(data) {
  try {
    let offset = 8; // Skip the discriminator

    const name = decodeString(data, offset);
    offset += name.bytesRead;

    const symbol = decodeString(data, offset);
    offset += symbol.bytesRead;

    const uri = decodeString(data, offset);

    return {
      name: name.value,
      symbol: symbol.value,
      uri: uri.value,
    };
  } catch (error) {
    return null;
  }
}


function extractAccounts(transaction, instructionIndex) {
  try {
    const message = transaction.transaction.message;
    const instruction = message.instructions[instructionIndex];
    const accountKeys = message.accountKeys;

    // Convert Uint8Array to regular array
    const accountIndices = Array.from(instruction.accounts);

    // Map indices to actual addresses
    const accounts = accountIndices.map((idx) => {
      const accountKey = accountKeys[idx];
      return bs58.encode(Buffer.from(accountKey));
    });

    return {
      mint: accounts[0],
      bondingCurve: accounts[2],
      creator: accounts[7],
    };
  } catch (error) {
    return null;
  }
}

function isCreateInstruction(instruction, accountKeys) {
  // Check if it's the Pump.fun program
  const programIdx = instruction.programIdIndex;
  const programId = bs58.encode(accountKeys[programIdx]);

  if (programId !== PUMPFUN_PROGRAM) return false;

  // Check if it's a create instruction
  const data = Buffer.from(instruction.data);
  return data.slice(0, 8).equals(CREATE_DISCRIMINATOR);
}

function displayTokenMint(tokenData, signature, slot) {
  stats.totalMints++;
  stats.lastMintTime = new Date();

  console.log("\n" + "=".repeat(80));
  console.log(`🎉 NEW PUMP.FUN TOKEN MINT #${stats.totalMints}`);
  console.log("=".repeat(80));

  console.log(`\n📛 NAME:        ${tokenData.name}`);
  console.log(`🏷️  SYMBOL:      $${tokenData.symbol}`);
  console.log(`\n🪙 MINT:        ${tokenData.mint}`);
  console.log(`👤 CREATOR:     ${tokenData.creator}`);
  console.log(`📊 BONDING:     ${tokenData.bondingCurve}`);
  console.log(`\n🔗 METADATA:    ${tokenData.uri}`);
  console.log(`📜 SIGNATURE:   ${signature}`);
  console.log(`🎰 SLOT:        ${slot}`);

  console.log(`\n🔍 EXPLORE:`);
  console.log(`   Token:   https://solscan.io/token/${tokenData.mint}`);
  console.log(`   TX:      https://solscan.io/tx/${signature}`);
  console.log(`   Creator: https://solscan.io/account/${tokenData.creator}`);

  console.log("\n" + "=".repeat(80) + "\n");
}

async function monitorPumpfunMints() {
  console.log("🚀 Starting Pump.fun Token Mint Monitor");
  console.log(`🎯 Watching program: ${PUMPFUN_PROGRAM}\n`);
  console.log("Waiting for new token mints...\n");
  
  return new Promise(async (resolve, reject) => {
    try {
      // Connect to GetBlock.io
      const client = new Client(ENDPOINT, TOKEN, undefined);
      const stream = await client.subscribe();

      const request = {
        accounts: {},
        slots: {},
        transactions: {
          pumpfun: {
            accountInclude: [PUMPFUN_PROGRAM],
            accountExclude: [],
            accountRequired: []
          }
        },
        transactionsStatus: {},
        entry: {},
        blocks: {},
        blocksMeta: {},
        commitment: CommitmentLevel.CONFIRMED,
        accountsDataSlice: [],
        ping: undefined
      };
 stream.on("data", (message) => {
        try {
          // Keep connection alive
          if (message.pong) {
            stream.write({ ping: { id: message.pong.id } });
            return;
          }
          
          // Check if this is a transaction we care about
          if (message.transaction && message.filters && 
              message.filters.includes('pumpfun')) {
            
            const tx = message.transaction.transaction;
            const signature = bs58.encode(tx.signature);
            const slot = message.transaction.slot.toString();

 const txMessage = tx.transaction.message;
            const accountKeys = txMessage.accountKeys;
            const instructions = txMessage.instructions;
            
            // Check each instruction in the transaction
            for (let i = 0; i < instructions.length; i++) {
              const instruction = instructions[i];
              
              if (isCreateInstruction(instruction, accountKeys)) {
                // Parse the token data
                const instructionData = Buffer.from(instruction.data);
                const tokenMetadata = parseCreateInstruction(instructionData);
                
                if (!tokenMetadata) continue;
                
                // Extract account addresses
                const accounts = extractAccounts(
                  { transaction: { message: txMessage } },
                  i
                );
                
                if (!accounts) continue;
                
                // Display the new token!
                displayTokenMint(
                  { ...tokenMetadata, ...accounts },
                  signature,
                  slot
                );
              }
            }
          }
        } catch (error) {
          console.error(`Error: ${error.message}`);
        }
      });

      
      stream.write(request, (err) => {
        if (err) {
          reject(err);
        } else {
          console.log("✅ Subscription active - monitoring blockchain...\n");
        }
      });
      
    } catch (error) {
      reject(error);
    }
  });
}

async function main() {
  try {
    await monitorPumpfunMints();
  } catch (error) {
    console.error("Monitor crashed:", error.message);
    console.log("Restarting in 5 seconds...");
    setTimeout(main, 5000);
  }
}
process.on('SIGINT', () => {
  console.log("\n\n🛑 Shutting down...");
  console.log(`\nTotal mints detected: ${stats.totalMints}`);
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  console.log(`Uptime: ${Math.floor(uptime / 60)}m ${uptime % 60}s\n`);
  process.exit(0);
});

main();