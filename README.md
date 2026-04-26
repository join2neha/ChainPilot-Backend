# 🚀 ChainPilot - Your AI Co-Pilot for On-Chain Decisions

ChainPilot is an AI-powered portfolio assistant that connects to a user’s crypto wallet, analyzes on-chain behavior, understands market conditions, and generates **explainable trading decisions**.

Built with focuses on **clarity, intelligence, and transparency** - not black-box predictions.

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

### Wallet Intelligence

* Connect wallet (address-based)
* Analyze transaction behavior
* Classify users into:

  * Beginner
  * Intermediate
  * Advanced

---

### Market Awareness

* Fetch token price data
* Derive simple indicators (RSI-like logic)
* Identify:

  * Overbought conditions
  * Oversold conditions

---

### AI Decision Engine (Core)

* Generates: **BUY / SELL / HOLD**
* Based on:

  * User experience level
  * Market conditions
* Outputs:

  * Action
  * Confidence score
  * Human-readable reasoning

---

### Explainable AI Interface

* Chat-like responses
* Transparent reasoning (no black box)

Example:

> “I'm seeing oversold conditions - this could be a good entry point.
> Since you're a beginner, I’m suggesting a cautious BUY.”

---

### AI-Assisted Trade Execution

* User-approved execution (not autonomous)
* Mock or real blockchain interaction

---

### Decision Memory (On-chain Inspired)

* Every decision is stored
* Enables:

  * History tracking
  * Transparency
  * AI “memory” simulation

---

## System Architecture

```text
Frontend (Chat UI)
        ↓
Backend (NestJS)

Modules:
- Wallet Service → Analyze user
- Market Service → Fetch data
- AI Engine → Generate decisions
- Trade Service → Execute trades
- History Service → Store decisions
```

---

## Tech Stack

* **Backend:** NestJS
* **Database:** PostgreSQL
* **Cache:** Redis
* **Web3:** ethers.js
* **Storage:** 0G

<!-- ---

## 🔌 API Endpoints

### 1. Connect Wallet

```
POST /wallet/connect
```

### 2. Get AI Decision ⭐

```
POST /ai/decision
```

### 3. Execute Trade

```
POST /trade/execute
```

### 4. Get Decision History

```
GET /history/:wallet
```

--- -->

## AI Decision Logic

* Beginner:

  * RSI LOW → BUY
  * RSI HIGH → HOLD

* Advanced:

  * RSI HIGH → SELL
  * RSI LOW → BUY

👉 All decisions include reasoning + confidence.

---

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

### 3. Run the server

```
npm run start:dev
```

---

<!-- ## 🔮 Future Enhancements

* Real on-chain data analysis (via ethers.js)
* Advanced indicators (MACD, volatility)
* Personalized risk scoring
* Fully decentralized decision storage
* Autonomous trading agents (with safeguards) -->

<!-- --- -->

## Why ChainPilot Stands Out

* Explainable AI (not black-box)
* Web3-native design
* User-personalized decisions
* Combines user behavior + market data
* Transparent decision history

---

## 👩‍💻 Author

Built with ❤️ by Team ChainPilot (Neha Verma & Akshay Tiwari).
