// dependencies
import WebSocket from 'ws';
import { config } from 'dotenv';

// Load environment variables from .env file
config();
const CONFIG = {
  // HyperEVM WebSocket endpoint from GetBlock
  HYPEREVM_WSS: process.env.HYPEREVM_WSS,
  
  // Whale thresholds
  WHALE_THRESHOLD_USD: Number(process.env.WHALE_THRESHOLD_USD) || 100000,
  WHALE_THRESHOLD_SIZE: Number(process.env.WHALE_THRESHOLD_SIZE) || 50,
  
  // Notification settings
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  TELEGRAM_BATCH_ALERTS: process.env.TELEGRAM_BATCH_ALERTS !== 'false',
  TELEGRAM_BATCH_INTERVAL: Number(process.env.TELEGRAM_BATCH_INTERVAL) || 60 * 10000,
  
  // Tracked markets
  TRACKED_SYMBOLS: (process.env.TRACKED_SYMBOLS || 'BTC,ETH,SOL,ARB,AVAX,HYPE').split(','),
};

class HyperliquidWhaleTracker {
  constructor() {
    this.ws = null;
    this.wsHyperEVM = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.priceCache = {};
    this.whaleAddresses = new Map(); // Track whale addresses and their activity
    this.tradeCount = 0;
    this.telegramQueue = []; // Queue for Telegram messages
    this.isSendingTelegram = false;
    this.lastTelegramSent = 0;
    this.TELEGRAM_DELAY = 1500; // 1.5 seconds between messages
    this.pendingAlerts = []; // For batching
    this.batchTimer = null;
  }

  // Connect to HyperEVM WebSocket via GetBlock
  connectHyperEVM() {
    if (!CONFIG.HYPEREVM_WSS || CONFIG.HYPEREVM_WSS.includes('YOUR_')) {
      console.error('❌ Please configure your HyperEVM WebSocket endpoint!');
      return;
    }

    console.log('Connecting to HyperEVM via GetBlock...');
    
    this.wsHyperEVM = new WebSocket(CONFIG.HYPEREVM_WSS);

    this.wsHyperEVM.on('open', () => {
      console.log('✅ Connected to HyperEVM WebSocket');
      this.reconnectAttempts = 0;
      this.subscribeToHyperEVMBlocks();
    });

    this.wsHyperEVM.on('message', (data) => {
      this.handleHyperEVMMessage(data);
    });

    this.wsHyperEVM.on('error', (error) => {
      console.error('HyperEVM WebSocket error:', error.message);
    });

    this.wsHyperEVM.on('close', () => {
      console.log('HyperEVM WebSocket closed');
      this.handleReconnect('hyperevm');
    });
  }

  // Connect to Hyperliquid Info WebSocket (main data source)
  connectHyperliquidInfo() {
    console.log('Connecting to Hyperliquid Info WebSocket...');
    
    this.ws = new WebSocket('wss://api.hyperliquid.xyz/ws');

    this.ws.on('open', () => {
      console.log('✅ Connected to Hyperliquid Info API');
      this.subscribeToTrades();
      this.subscribeToOrderbook();
    });

    this.ws.on('message', (data) => {
      this.handleHyperliquidMessage(data);
    });

    this.ws.on('error', (error) => {
      console.error('Hyperliquid WebSocket error:', error.message);
    });

    this.ws.on('close', () => {
      console.log('Hyperliquid WebSocket closed');
      this.handleReconnect('hyperliquid');
    });
  }

  subscribeToHyperEVMBlocks() {
    const subscribe = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_subscribe',
      params: ['newHeads']
    };

    this.wsHyperEVM.send(JSON.stringify(subscribe));
    console.log('📡 Subscribed to HyperEVM new blocks');
  }

  subscribeToTrades() {
    // Subscribe to all trades
    const subscription = {
      method: 'subscribe',
      subscription: {
        type: 'allMids'
      }
    };

    this.ws.send(JSON.stringify(subscription));
    
    // Subscribe to trades for tracked symbols
    CONFIG.TRACKED_SYMBOLS.forEach(symbol => {
      const tradesSub = {
        method: 'subscribe',
        subscription: {
          type: 'trades',
          coin: symbol
        }
      };
      this.ws.send(JSON.stringify(tradesSub));
    });

    console.log('📡 Subscribed to Hyperliquid trades');
  }

  subscribeToOrderbook() {
    // Subscribe to L2 orderbook for volume analysis
    CONFIG.TRACKED_SYMBOLS.forEach(symbol => {
      const l2Sub = {
        method: 'subscribe',
        subscription: {
          type: 'l2Book',
          coin: symbol
        }
      };
      this.ws.send(JSON.stringify(l2Sub));
    });

    console.log('📊 Subscribed to orderbook data');
  }

  handleHyperEVMMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.params && message.params.result) {
        const block = message.params.result;
        console.log(`📦 New HyperEVM block: ${parseInt(block.number, 16)}`);
      }
    } catch (error) {
      console.error('Error parsing HyperEVM message:', error);
    }
  }

  handleHyperliquidMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      
      // Handle trade data
      if (message.channel === 'trades' && message.data) {
        message.data.forEach(trade => {
          this.analyzeTrade(trade);
        });
      }

      // Handle price updates
      if (message.channel === 'allMids' && message.data) {
        this.updatePrices(message.data);
      }

      // Handle orderbook updates
      if (message.channel === 'l2Book' && message.data) {
        this.analyzeOrderbook(message.data);
      }
    } catch (error) {
      console.error('Error parsing Hyperliquid message:', error);
    }
  }

  updatePrices(midsData) {
    if (midsData.mids) {
      Object.entries(midsData.mids).forEach(([symbol, price]) => {
        this.priceCache[symbol] = parseFloat(price);
      });
    }
  }

  analyzeTrade(trade) {
    try {
      const { coin, side, px, sz, time, user, hash, tid } = trade;
      const price = parseFloat(px);
      const size = parseFloat(sz);
      const value = price * size;

      // Check if it's a whale trade
      if (value >= CONFIG.WHALE_THRESHOLD_USD || size >= CONFIG.WHALE_THRESHOLD_SIZE) {
        // Track whale address
        if (user && user !== 'Unknown') {
          this.trackWhaleAddress(user, value, coin);
        }

        this.notifyWhaleTrade({
          coin,
          side,
          price,
          size,
          value,
          time: new Date(time).toLocaleString(),
          user: user || 'Unknown',  // Wallet address
          hash: hash || null,        // Transaction hash
          tradeId: tid || null       // Trade ID
        });
        
        this.tradeCount++;
      }
    } catch (error) {
      console.error('Error analyzing trade:', error);
    }
  }

  trackWhaleAddress(address, value, coin) {
    if (this.whaleAddresses.has(address)) {
      const whale = this.whaleAddresses.get(address);
      whale.totalVolume += value;
      whale.tradeCount++;
      whale.lastSeen = new Date();
      whale.coins.add(coin);
    } else {
      this.whaleAddresses.set(address, {
        address,
        totalVolume: value,
        tradeCount: 1,
        firstSeen: new Date(),
        lastSeen: new Date(),
        coins: new Set([coin])
      });
    }
  }

  analyzeOrderbook(bookData) {
    try {
      const { coin, levels } = bookData;
      
      if (!levels || !Array.isArray(levels)) return;

      const largeOrders = [];

      // Analyze bids (buy orders) - levels[0]
      if (Array.isArray(levels[0])) {
        levels[0].forEach(level => {
          // Each level can be [price, size] or {px, sz, n}
          let price, size;
          
          if (Array.isArray(level)) {
            [price, size] = level;
          } else if (level.px && level.sz) {
            price = level.px;
            size = level.sz;
          } else {
            return; // Skip invalid format
          }

          const value = parseFloat(price) * parseFloat(size);
          if (value >= CONFIG.WHALE_THRESHOLD_USD) {
            largeOrders.push({ 
              side: 'BID', 
              price: parseFloat(price), 
              size: parseFloat(size), 
              value 
            });
          }
        });
      }

      // Analyze asks (sell orders) - levels[1]
      if (Array.isArray(levels[1])) {
        levels[1].forEach(level => {
          let price, size;
          
          if (Array.isArray(level)) {
            [price, size] = level;
          } else if (level.px && level.sz) {
            price = level.px;
            size = level.sz;
          } else {
            return;
          }

          const value = parseFloat(price) * parseFloat(size);
          if (value >= CONFIG.WHALE_THRESHOLD_USD) {
            largeOrders.push({ 
              side: 'ASK', 
              price: parseFloat(price), 
              size: parseFloat(size), 
              value 
            });
          }
        });
      }

      if (largeOrders.length > 0) {
        this.notifyWhaleOrder(coin, largeOrders);
      }
    } catch (error) {
      console.error('Error analyzing orderbook:', error.message);
      // Optional: Log the actual data structure to debug
      // console.log('Orderbook data:', JSON.stringify(bookData, null, 2));
    }
  }

  notifyWhaleTrade(trade) {
    const emoji = trade.side === 'B' ? '🟢' : '🔴';
    const sideText = trade.side === 'B' ? 'BUY' : 'SELL';
    
    // Shorten address for display
    const shortAddress = trade.user && trade.user !== 'Unknown' 
      ? `${trade.user.slice(0, 6)}...${trade.user.slice(-4)}`
      : 'Unknown';
    
    const message = `
🐋 WHALE TRADE ALERT! 🐋

${emoji} ${sideText} ${trade.coin}

💰 Size: ${trade.size.toFixed(2)} contracts
💵 Price: ${trade.price.toFixed(2)}
📊 Value: ${trade.value.toLocaleString()}
👤 Trader: ${shortAddress}
${trade.user && trade.user !== 'Unknown' ? `🔗 Address: ${trade.user}` : ''}
${trade.hash ? `📝 TX Hash: ${trade.hash}` : ''}
${trade.tradeId ? `🆔 Trade ID: ${trade.tradeId}` : ''}
🕐 Time: ${trade.time}

${trade.value >= 500000 ? '🚨 MEGA WHALE! 🚨' : ''}
    `;

    console.log(message);
    
    if (CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID) {
      this.sendTelegramMessage(message);
    }
  }

  notifyWhaleOrder(coin, orders) {
    const message = `
🐳 WHALE WALL DETECTED! 🐳

📈 ${coin} Orderbook

${orders.map(o => 
  `${o.side === 'BID' ? '🟢' : '🔴'} ${o.side}: $${parseFloat(o.price).toFixed(2)} × ${parseFloat(o.size).toFixed(2)} = $${o.value.toLocaleString()}`
).join('\n')}

🕐 ${new Date().toLocaleString()}
    `;

    console.log(message);
    
    if (CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID) {
      this.sendTelegramMessage(message);
    }
  }

  sendBatchedAlerts() {
    if (this.pendingAlerts.length === 0) {
      this.batchTimer = null;
      return;
    }

    const totalValue = this.pendingAlerts.reduce((sum, alert) => sum + alert.value, 0);
    const trades = this.pendingAlerts.length;
    
    let message = `🐋 WHALE ACTIVITY BATCH (${trades} trades, ${totalValue.toLocaleString()} total) 🐋\n\n`;
    
    this.pendingAlerts.forEach((alert, index) => {
      const shortAddr = alert.user && alert.user !== 'Unknown' 
        ? `${alert.user.slice(0, 6)}...${alert.user.slice(-4)}`
        : 'Unknown';
      
      message += `${index + 1}. ${alert.emoji} ${alert.sideText} ${alert.coin}\n`;
      message += `   💰 ${alert.value.toLocaleString()} | 👤 ${shortAddr}\n`;
      if (alert.value >= 500000) message += `   🚨 MEGA WHALE!\n`;
      message += `\n`;
    });
    
    message += `🕐 ${new Date().toLocaleString()}`;
    
    this.sendTelegramMessage(message);
    this.pendingAlerts = [];
    this.batchTimer = null;
  }

  async sendTelegramMessage(message) {
    if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;

    // Add to queue instead of sending immediately
    this.telegramQueue.push(message);
    
    // Start processing queue if not already running
    if (!this.isSendingTelegram) {
      this.processTelegramQueue();
    }
  }

  async processTelegramQueue() {
    if (this.telegramQueue.length === 0) {
      this.isSendingTelegram = false;
      return;
    }

    this.isSendingTelegram = true;

    // Get next message
    const message = this.telegramQueue.shift();

    try {
      // Respect rate limit
      const now = Date.now();
      const timeSinceLastSend = now - this.lastTelegramSent;
      
      if (timeSinceLastSend < this.TELEGRAM_DELAY) {
        await new Promise(resolve => setTimeout(resolve, this.TELEGRAM_DELAY - timeSinceLastSend));
      }

      const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: CONFIG.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'HTML'
        })
      });

      this.lastTelegramSent = Date.now();

      if (!response.ok) {
        const errorData = await response.json();
        console.error('❌ Telegram API error:', response.status, errorData.description || '');
        
        // If rate limited, wait longer
        if (response.status === 429) {
          const retryAfter = errorData.parameters?.retry_after || 5;
          console.log(`⏳ Rate limited. Waiting ${retryAfter} seconds...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          // Re-add message to front of queue
          this.telegramQueue.unshift(message);
        }
      } else {
        console.log('✅ Telegram message sent successfully');
      }
    } catch (error) {
      console.error('❌ Telegram error:', error.message);
    }

    // Process next message in queue
    setTimeout(() => this.processTelegramQueue(), this.TELEGRAM_DELAY);
  }

  handleReconnect(connection) {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      
      console.log(`Reconnecting ${connection} in ${delay/1000}s... (Attempt ${this.reconnectAttempts})`);
      
      setTimeout(() => {
        if (connection === 'hyperevm') {
          this.connectHyperEVM();
        } else {
          this.connectHyperliquidInfo();
        }
      }, delay);
    } else {
      console.error(`Max reconnection attempts reached for ${connection}`);
    }
  }

  start() {
    console.log('🚀 Starting Hyperliquid Whale Tracker...');
    console.log(`📊 Tracking: ${CONFIG.TRACKED_SYMBOLS.join(', ')}`);
    console.log(`💰 Whale threshold: ${CONFIG.WHALE_THRESHOLD_USD.toLocaleString()}\n`);
    
    // Connect to Hyperliquid's Info API (primary data source)
    this.connectHyperliquidInfo();
    
    // Optionally connect to HyperEVM if configured
    if (CONFIG.HYPEREVM_WSS && !CONFIG.HYPEREVM_WSS.includes('YOUR_')) {
      this.connectHyperEVM();
    } else {
      console.log('ℹ️  HyperEVM WebSocket not configured (optional)\n');
    }

    // Print whale statistics every 5 minutes
    setInterval(() => {
      this.printWhaleStats();
    }, 5 * 60 * 1000);
  }

  printWhaleStats() {
    console.log('\n' + '='.repeat(60));
    console.log('📊 WHALE STATISTICS SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total Whale Trades Detected: ${this.tradeCount}`);
    console.log(`Unique Whale Addresses: ${this.whaleAddresses.size}\n`);

    if (this.whaleAddresses.size > 0) {
      console.log('Top 10 Whales by Volume:');
      console.log('-'.repeat(60));
      
      const sortedWhales = Array.from(this.whaleAddresses.values())
        .sort((a, b) => b.totalVolume - a.totalVolume)
        .slice(0, 10);

      sortedWhales.forEach((whale, index) => {
        const shortAddr = `${whale.address.slice(0, 8)}...${whale.address.slice(-6)}`;
        console.log(`${index + 1}. ${shortAddr}`);
        console.log(`   Volume: ${whale.totalVolume.toLocaleString()}`);
        console.log(`   Trades: ${whale.tradeCount}`);
        console.log(`   Markets: ${Array.from(whale.coins).join(', ')}`);
        console.log(`   Last Active: ${whale.lastSeen.toLocaleString()}\n`);
      });
    }
    console.log('='.repeat(60) + '\n');
  }

  stop() {
    if (this.ws) this.ws.close();
    if (this.wsHyperEVM) this.wsHyperEVM.close();
    console.log('Bot stopped');
  }
}

// Start the bot
const bot = new HyperliquidWhaleTracker();
bot.start();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  bot.stop();
  process.exit(0);
});