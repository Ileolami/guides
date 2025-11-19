# Basic Ethereum MCP

Minimal Model Context Protocol (MCP) server that exposes simple Ethereum utilities as MCP tools using `@modelcontextprotocol/sdk`.

### Overview
- Implements a small MCP server (stdio transport) that connects to an Ethereum JSON-RPC provider and exposes tools:
  - `get_eth_balance` — returns ETH balance for an address
  - `get_gas_price` — returns current gas price / fee data
  - `get_block_number` — returns the latest block number
  - `get_transaction_count` — returns the nonce/tx count for an address

### Key files
- `server.js` — main MCP server implementation
- `.env` / `.env.example` — environment variables (see below)
- `package.json` — project manifest (start script: `node server.js`)

### Prerequisites
- Node.js 16+ (LTS recommended)
- An Ethereum JSON-RPC provider and API token (GetBlock, Alchemy, Infura, etc.)

### Environment
Create a `.env` file at the project root. Required variables:

```
GETBLOCK_TOKEN=<YOUR_GETBLOCK_TOKEN>
```

### Notes
- The server uses `ethers` with a GetBlock-style endpoint constructed as `https://go.getblock.us/${GETBLOCK_TOKEN}/`. If you use a different provider, update the provider URL in `server.js`.
- The MCP server uses the stdio transport so it is intended to be attached to an MCP-capable client (for example, Claude Desktop or any tool that communicates over stdio using MCP framing).

### Run

```bash
# install deps
npm install

# start the MCP server (stdio transport)
node server.js
```

Example usage (from an MCP client)
- Call the `get_eth_balance` tool with a valid Ethereum address to receive a JSON text response containing `balance` (in ETH) and `balanceWei`.

### Troubleshooting
- Provider / network errors: confirm `GETBLOCK_TOKEN` is correct and that the provider URL you use matches your provider's docs.
- Ethers errors: ensure the `ethers` version in `package.json` is compatible with Node.js and your provider.
- MCP transport: this server expects a stdio transport. If you plan to run it as a standalone HTTP service, you'll need to change the transport and connection logic.
