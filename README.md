# Aevum tUSD8 PayStream

**Programmable Stablecoin Streaming, Instant Invoice Factoring, ERC-8004 Confirmation of Payee & Atomic Escrow DApp on QDay Aevum Testnet (`Chain ID 44005`)**

[![Network](https://img.shields.io/badge/QDay%20Aevum%20Testnet-Chain%20ID%2044005%20(0xABE5)-38BDF8)](https://explorer-test.qday.info)
[![Stablecoin](https://img.shields.io/badge/Stablecoin-tUSD8%20(6%20Decimals)-10B981)](https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.28-64748B)](./contracts/TUSD8PayStream.sol)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED)](./Dockerfile)

> Built for **DoraHacks — QDay Aevum Builder Challenge #1 (`$1,500 USDT` Prize Pool)**  
> **Builder / Recipient Wallet (`EVM` / `USDT` / `tUSD8`)**: `0x958cbC9378c75cf158e5B19845E7f004B5f8c3f9`

---

## 1. Problem Statement & Product Overview

Enterprise treasuries, SaaS merchants, and autonomous AI agents transacting in **tUSD8** (`0x456569838f1d43009A91ebA4263147Afd7233483`, 6 decimals) on **QDay Aevum** face four core friction points:

1. **Lump-Sum Payroll & Compute Risk**: Paying contractors or GPU providers upfront in lump sums exposes payers to non-delivery, whereas paying in arrears starves providers of working capital.
2. **Illiquid Accounts Receivable (Net-30 / Net-60 Invoices)**: Merchants issuing on-chain `tUSD8` invoices wait weeks for settlement without a native on-chain factoring liquidity layer.
3. **Address-Poisoning & Fat-Finger Transfers**: Standard ERC-20 `transfer` calls do not verify whether the destination address matches the intended legal entity's identity.
4. **Unbounded AI Agent Keys**: Autonomous agents need to pay `x402` and merchant APIs in `tUSD8` without risking runaway spend or prompt-injection wallet drains.

**Aevum tUSD8 PayStream** solves all four problems in a unified, modular Solidity protocol (`TUSD8PayStream.sol` + `ERC8004PayeeRegistry.sol`) purpose-built for **QDay Aevum Testnet (`chainId: 44005`)**:

- **Per-Second `tUSD8` Streaming (`createStream`, `withdrawFromStream`, `cancelStream`)**: Continuous linear `tUSD8` streaming with optional cliff periods and pro-rata sender/recipient refund on cancellation.
- **On-Chain `tUSD8` Invoicing & Instant LP Factoring (`createInvoice`, `factorInvoice`, `payInvoice`)**: Merchants issue `tUSD8` invoices with a `maxDiscountBps` cap; Liquidity Providers advance immediate `tUSD8` (`amount - discount`) to the merchant, and the contract automatically routes the payer's settlement to the LP.
- **ERC-8004 Confirmation of Payee (`ERC8004PayeeRegistry.sol`)**: Binds recipient addresses to cryptographic identity hashes (`keccak256(abi.encodePacked(displayName))`) and blocks transfers if the on-chain identity hash does not match.
- **Atomic Milestone Escrow (`createEscrow`, `releaseEscrow`, `refundExpiredEscrow`)**: Locks `tUSD8` behind 32-byte SHA-256 deliverable verification and arbiter dispute resolution.
- **Scoped AI Agent Session Keys (`authorizeSessionKey`, `executeAgentPayment`, `revokeSessionKey`)**: Enforces on-chain `maxSinglePayment`, rolling 24-hour `maxDailySpend`, `validUntil` expiration, and mandatory ERC-8004 payee verification for autonomous AI agents.

---

## 2. System Architecture

```mermaid
flowchart TD
    subgraph Human_And_Agent_Signers["Human & Autonomous Agent Signers"]
        Owner["Treasury / Payer Wallet\n0x958cbC...8c3f9"]
        Agent["Scoped AI Agent Session Key\n(maxSinglePayment + 24h Spend Cap)"]
        LP["Factoring Liquidity Provider\n(Advances tUSD8 at Discount BPS)"]
    end

    subgraph QDay_Aevum_Testnet["QDay Aevum Testnet (Chain ID: 44005 / 0xABE5)"]
        COP["ERC8004PayeeRegistry.sol\nConfirmation of Payee (ERC-8004)"]
        PayStream["TUSD8PayStream.sol\n1. Per-Second tUSD8 Streams\n2. Invoice & LP Factoring\n3. SHA-256 Milestone Escrow\n4. AI Agent Session Policy"]
        TUSD8["Official tUSD8 ERC-20 (6 Decimals)\n0x456569838f1d43009A91ebA4263147Afd7233483"]
    end

    Owner -->|createStream / payInvoice / createEscrow| PayStream
    Agent -->|executeAgentPayment (x402)| PayStream
    LP -->|factorInvoice (Immediate Advance)| PayStream
    PayStream -->|verifyPayee(recipient, hash)| COP
    PayStream -->|transfer / transferFrom| TUSD8
```

---

## 3. QDay Aevum Testnet Specifications & Verified Addresses

| Parameter | Value |
| :--- | :--- |
| **Network Name** | `QDay Aevum Testnet` |
| **Chain ID** | `44005` (`0xABE5`) |
| **RPC Endpoint** | `https://rpc-test.qday.info` |
| **WebSocket Endpoint** | `wss://rpc-test.qday.info` |
| **Block Explorer** | `https://explorer-test.qday.info` |
| **Faucet** | `https://faucet.qday.info/en` |
| **Native Gas Token** | `tQDAY` (`18` decimals) |
| **Official `tUSD8` Stablecoin** | `0x456569838f1d43009A91ebA4263147Afd7233483` (`6` decimals) |
| **Official `QDayFaucet` Contract** | `0x33d19Bde2e1798c13808f17BfBa1780b28e4bACC` |
| **Official `tUSD8Faucet` Contract** | `0x4551B2a3dE4F43e6613E23edf798Ab4FB0211564` |
| **Official `WABEL` Contract** | `0x4668107253E28C2b569E76Edb14B1E88c3b93de1` (`18` decimals) |
| **Official `WQDAY` Contract** | `0x915E807e7EC1665889172902781FB851202A54dF` (`18` decimals) |

---

## 4. Turnkey Setup & Reproduction Instructions

### Option A — Local Node.js Setup (`>= 18`)

```bash
git clone https://github.com/LBCron/aevum-tusd8-paystream.git
cd aevum-tusd8-paystream
npm install --ignore-scripts

# 1. Compile Solidity contracts (ERC8004PayeeRegistry.sol, TUSD8PayStream.sol, MockTUSD8.sol)
npm run compile

# 2. Run full unit & live QDay Aevum RPC integration test suite
npm test

# 3. Run end-to-end CLI deployment & 5-stage payment workflow demonstration
npm run demo

# 4. Launch the interactive Web Dashboard on http://localhost:3000
npm start
```

### Option B — Packaged Docker Deployment (Required by Aevum Challenge Rules)

```bash
docker build -t aevum-tusd8-paystream .
docker run -p 3000:3000 aevum-tusd8-paystream
# Open http://localhost:3000 in your browser
```

Or via Docker Compose:
```bash
docker compose up --build
```

### Environment Variables (Optional for Live Private-Key Broadcast)
- `PORT`: Web dashboard HTTP port (default: `3000`)
- `QDAY_AEVUM_RPC`: QDay Aevum RPC URL (default: `https://rpc-test.qday.info`)
- `PRIVATE_KEY`: Optional hex private key funded with `tQDAY` from `https://faucet.qday.info/en` to broadcast a fresh contract deployment via `npm run demo`.

---

## 5. Safety, Trust & Guardrail Controls

1. **ERC-8004 Confirmation of Payee**: Every stream, invoice settlement, escrow creation, and AI agent payment supports on-chain identity verification (`_enforcePayeeConfirmation`), preventing spoofed or poisoned addresses from receiving `tUSD8`.
2. **Least-Privilege AI Session Keys**: Scoped session keys enforce `maxSinglePayment`, rolling 24h `maxDailySpend`, `validUntil` timestamp, and instant owner revocation (`revokeSessionKey`).
3. **Reentrancy & Integer Safety**: Protected by a custom `nonReentrant` mutex and Solidity `0.8.28` checked arithmetic.

---

## 6. Roadmap to QDay Mainnet (`Chain ID 44002`, Q1 2027)

- **Phase 1 (Current — Aevum Testnet `44005`)**: Full `TUSD8PayStream` & `ERC8004PayeeRegistry` contracts, instant invoice factoring, AI agent session keys, and Dockerized web dashboard.
- **Phase 2 (Q1 2027 — QDay Mainnet `44002`)**: Native integration with `@qday-io/sdk` (`QDAYSmartAccount`, `USD8` stablecoin paymaster at `https://paymaster.qday.io`, and Alto Bundler at `https://bundler.qday.io`) for 100% gasless `USD8` streams and invoices.

---

## 7. License

Released under the [MIT License](./LICENSE). Built by **Ronan Chen Lopes (`@LBCron`)**.
