# 🚀 ChainPilot - Your AI Co-Pilot for On-Chain Decisions

ChainPilot is an AI-powered portfolio assistant that connects to a user's crypto wallet, analyzes on-chain behavior, understands market conditions, and generates **explainable trading decisions**.

Built with a focus on **clarity, intelligence, and transparency** - not black-box predictions.

---

## What Problem Are We Solving?

Crypto users often struggle with:

* Understanding their own trading behavior
* Interpreting market signals
* Making informed buy/sell decisions
* Trusting opaque AI tools

👉 ChainPilot solves this by acting as an **intelligent, explainable assistant** that:

* Understands the user
* Understands the market
* Explains every decision clearly

---

## Features

### 🔗 Wallet Intelligence

* Connect wallet (address-based, no passwords)
* Analyze on-chain transaction behavior via **Alchemy SDK**
* Classify users into:

  * Beginner
  * Intermediate
  * Advanced

* View full **portfolio summary** — token holdings with live USD values
* View **portfolio analytics** — performance data (D1–D30) and asset allocation breakdown
* **Trader DNA** — behavioral profiling: avg hold days, risk score, trading pattern

---

### 📈 Market Awareness

* Live 25-token scrolling ticker via **Binance**
* Fetch token price data via **CoinGecko**
* **Live Insight Cards** — real-time market signals with AI recommendations
* **Hero Banner Recommendation** — top token pick for the dashboard
* All market data is **Redis-cached** with force-refresh support

---

### 🤖 AI Decision Agent (Core)

A stateful, multi-step conversational agent powered by **OpenAI GPT**.  
It walks the user through a structured trade decision lifecycle:


* **INIT** — Loads wallet context, greets the user with a personalized analysis
* **GOAL** — User states their objective: `Increase Returns`, `Reduce Risk`, or `Explore`
* **STRATEGY** — Agent generates a trade suggestion (token in/out + allocation %)
* **CONFIRM** — User reviews and confirms, cancels, or modifies the suggestion
* **COMPLETE** — Decision recorded on **0G decentralized storage**, session cleared

> The agent **never executes trades**. It only advises and records decisions.

---

### 💬 Explainable AI Interface

* Chat-like conversational responses
* Transparent reasoning (no black box)
* Guided actions at every step

Example:

> "Based on your wallet, 60% of your portfolio is in stablecoins and your risk score is moderate.
> Since your goal is to increase returns, I'd suggest moving 20% from USDC → ETH.
> Would you like to proceed?"

---

### 🧠 Decision Memory (Decentralized)

* Every confirmed decision is uploaded to the **0G Storage Network** — a decentralized, verifiable data layer
* Stored locally in PostgreSQL with:

  * 0G transaction hash
  * Root hash
  * Explorer URL (Galileo chain scan)
  * Goal, trade details, and wallet context snapshot

* Enables:

  * Full decision history and transparency
  * Verifiable on-chain memory
  * AI "memory" that persists across sessions

---

### 🔄 Swap Intelligence Pro

* AI-powered swap recommendations with **confidence scoring**
* Three risk modes: `conservative`, `balanced`, `aggressive`
* Considers your portfolio composition and market conditions before suggesting a swap

---

### 📊 Portfolio Simulator

* Simulate portfolio allocation given:

  * Capital amount
  * Risk tolerance
  * Time horizon

* Returns projected outcomes and suggested asset splits

---

### ⏱️ Activity Timeline

* Unified chronological view of wallet activity
* Transactions, swaps, and significant events in one feed

---

### ⛓️ On-Chain Signals

* Aggregated on-chain signals for the dashboard
* Gas trends, DeFi activity indicators, and network health

---

## System Architecture

```text
Frontend (Chat UI)
        ↓
Backend (NestJS — Port 3001)

Modules:
- Wallet Service        → Analyze user, portfolio, analytics
- Market Service        → Live insights, hero recommendation
- Wallet Intelligence   → Trader DNA, risk scoring
- Wallet Recommendations→ AI-generated trade suggestions
- AI Agent              → Multi-step GPT-powered decision agent
- Swap Intelligence Pro → Confidence-scored swap recommendations
- Portfolio Simulator   → Allocation projection engine
- Onchain Service       → Aggregated on-chain signals
- Timeline Service      → Unified activity feed
- Trade Service         → Trade module
- History Service       → Decision history
```

## Tech Stack
```
- Backend: NestJS 11 (TypeScript)
- Database: PostgreSQL via TypeORM (Supabase hosted)
- Cache: Redis (session storage + market data caching)
- Web3 / RPC: Alchemy SDK (Ethereum, Polygon, Arbitrum)
- AI: OpenAI GPT
- Market Data: CoinGecko API + Binance
- Decentralized Storage: 0G Storage Network
- Auth: JWT (access + refresh tokens)
```

## API Endpoints

### Wallet
```
- POST   /wallet/connect              → Connect wallet, issue JWT
- GET    /wallet/analyze-wallet       → Full on-chain wallet analysis
- GET    /wallet/portfolio-summary    → Token holdings with USD values
- GET    /wallet/portfolio-analytics  → D1–D30 performance + asset allocation
- GET    /wallet/intelligence         → Trader DNA + behavioral profile
- GET    /wallet/recommendations      → AI trade recommendations
- GET    /wallet/global-market        → 25-token live ticker
- POST   /wallet/logout               → Invalidate session
```

### AI Agent ⭐
```
POST   /ai/agent                      → Multi-step conversational AI agent
```
Lifecycle: INIT → GOAL → STRATEGY → CONFIRM → COMPLETE

### Market
```
GET    /market/live-insights        → Live insight cards + recommendation
GET    /market/hero-recommendation  → Hero banner token pick
```

### Other
```
GET    /onchain/signals             → Aggregated on-chain signals
POST   /portfolio/simulate          → Portfolio allocation simulation
GET    /swap-intelligence-pro       → AI swap recommendations
GET    /timeline                    → Unified activity timeline
```

## AI Decision Logic
```
* Beginner:
  - High stablecoin % + low risk → Suggest cautious entry into ETH/BTC
  - RSI LOW → BUY

* Intermediate / Advanced:
  - Portfolio rebalancing based on allocation analysis
  - RSI HIGH → SELL, RSI LOW → BUY

* All decisions include:
  - Suggested token pair (in/out)
  - Allocation percentage
  - LLM-generated reasoning
  - Step-by-step confirmation flow

👉 All decisions include reasoning + confidence. Nothing executes without user confirmation.
```

## Getting Started

### 1. Clone the repo
```
git clone https://github.com/join2neha/ChainPilot-Backend
cd ChainPilot-Backend
```

### 2. Install dependencies
```
npm install
```

### 3. Set up environment variables
Create a .env file:
```
PORT=3001
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=chainpilot
REDIS_URL=redis://...
ALCHEMY_API_KEY=your_key
ALCHEMY_NETWORK=eth-mainnet
OPENAI_API_KEY=your_key
JWT_ACCESS_SECRET=your_secret
JWT_REFRESH_SECRET=your_secret
COINGECKO_API_KEY=your_key
ZG_PRIVATE_KEY=your_wallet_key
ZG_RPC_URL=https://evmrpc-testnet.0g.ai
ZG_INDEXER_RPC=https://indexer-storage-testnet-turbo.0g.ai
```

### 4. Run the server
```
npm run start:dev
```

Swagger API docs: http://localhost:3001/api-docs

## Why ChainPilot Stands Out
* 🧠 Explainable AI (not black-box)
* 🌐 Web3-native design
* 👤 User-personalized decisions
* 📊 Combines user behavior + market data + on-chain signals
* 🔒 Transparent, verifiable decision history on 0G decentralized storage
* 💬 Conversational agent with guided confirmation — never auto-executes


## 👩‍💻 Author

Built with ❤️ by Team ChainPilot (Neha Verma).