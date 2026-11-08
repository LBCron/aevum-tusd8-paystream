const { ethers } = require("ethers");

const AEVUM_CONFIG = {
  chainId: 44005,
  chainIdHex: "0xABE5",
  networkName: "QDay Aevum Testnet",
  rpcUrl: "https://rpc-test.qday.info",
  wsUrl: "wss://rpc-test.qday.info",
  explorerUrl: "https://explorer-test.qday.info",
  faucetUrl: "https://faucet.qday.info/en",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  contracts: {
    tUSD8: "0x456569838f1d43009A91ebA4263147Afd7233483",
    WABEL: "0x4668107253E28C2b569E76Edb14B1E88c3b93de1",
    WQDAY: "0x915E807e7EC1665889172902781FB851202A54dF",
    qdayFaucet: "0x33d19Bde2e1798c13808f17BfBa1780b28e4bACC",
    tusd8Faucet: "0x4551B2a3dE4F43e6613E23edf798Ab4FB0211564",
  },
  ownerWallet: "0x958cbC9378c75cf158e5B19845E7f004B5f8c3f9",
};

const ROLLING_WINDOW_SECONDS = 86_400;
const BPS_DENOMINATOR = 10_000n;
const MAX_FACTORING_DISCOUNT_BPS = 2_500;

/**
 * Deterministic stateful execution engine mirroring `ERC8004PayeeRegistry.sol`,
 * `TUSD8PayStream.sol`, and `MockTUSD8.sol` with exact Solidity ABI encoding and
 * custom error semantics.
 */
class PayStreamEngine {
  constructor(initialTimestamp = Math.floor(Date.now() / 1000)) {
    this.timestamp = Number(initialTimestamp);
    this.balances = new Map();
    this.payees = new Map(); // address.toLowerCase() -> { identityHash, displayName, metadataUri, registeredAt, active }
    this.hashToAddress = new Map(); // identityHash -> address

    this.nextStreamId = 1;
    this.nextInvoiceId = 1;
    this.nextEscrowId = 1;

    this.totalVolumeLocked = 0n;
    this.totalVolumeSettled = 0n;

    this.streams = new Map();
    this.invoices = new Map();
    this.escrows = new Map();
    this.sessionPolicies = new Map(); // `${owner}:${sessionKey}` -> policy
    this.txLogs = [];
  }

  advanceTime(seconds) {
    this.timestamp += Number(seconds);
    return this.timestamp;
  }

  mintTUSD8(account, amountBaseUnits) {
    const key = ethers.getAddress(account);
    const cur = this.balances.get(key) || 0n;
    const added = BigInt(amountBaseUnits);
    this.balances.set(key, cur + added);
    return cur + added;
  }

  balanceOf(account) {
    return this.balances.get(ethers.getAddress(account)) || 0n;
  }

  _transfer(from, to, amount) {
    const fromAddr = ethers.getAddress(from);
    const toAddr = ethers.getAddress(to);
    const val = BigInt(amount);
    const curFrom = this.balanceOf(fromAddr);
    if (curFrom < val) {
      throw new Error(`TransferFailed: insufficient tUSD8 balance (${curFrom} < ${val})`);
    }
    this.balances.set(fromAddr, curFrom - val);
    this.balances.set(toAddr, this.balanceOf(toAddr) + val);
  }

  _recordTx(action, sender, details) {
    const raw = JSON.stringify({
      action,
      sender,
      ts: this.timestamp,
      seq: this.txLogs.length + 1,
      details,
    });
    const txHash = ethers.keccak256(ethers.toUtf8Bytes(raw));
    const entry = {
      txHash,
      timestamp: this.timestamp,
      action,
      sender,
      ...details,
    };
    this.txLogs.unshift(entry);
    return entry;
  }

  // =========================================================================
  // ERC-8004 Confirmation of Payee Registry
  // =========================================================================

  computeIdentityHash(displayName) {
    return ethers.keccak256(ethers.toUtf8Bytes(displayName));
  }

  registerPayee(caller, displayName, metadataUri = "ipfs://qday-aevum-cop") {
    if (!displayName || displayName.trim().length === 0) {
      throw new Error("EmptyDisplayName");
    }
    const addr = ethers.getAddress(caller);
    const identityHash = this.computeIdentityHash(displayName);
    const existingOwner = this.hashToAddress.get(identityHash);
    if (existingOwner && existingOwner !== addr) {
      throw new Error(`IdentityHashCollision: ${identityHash} already owned by ${existingOwner}`);
    }

    const prev = this.payees.get(addr);
    if (prev && prev.identityHash !== identityHash) {
      this.hashToAddress.delete(prev.identityHash);
    }

    const record = {
      address: addr,
      identityHash,
      displayName,
      metadataUri,
      registeredAt: this.timestamp,
      active: true,
    };
    this.payees.set(addr, record);
    this.hashToAddress.set(identityHash, addr);

    this._recordTx("ERC8004:registerPayee", addr, {
      displayName,
      identityHash,
    });
    return record;
  }

  revokePayee(caller) {
    const addr = ethers.getAddress(caller);
    const rec = this.payees.get(addr);
    if (!rec || !rec.active) {
      throw new Error(`PayeeNotRegistered: ${addr}`);
    }
    rec.active = false;
    this.hashToAddress.delete(rec.identityHash);
    this._recordTx("ERC8004:revokePayee", addr, { identityHash: rec.identityHash });
  }

  verifyPayee(payee, expectedIdentityHash) {
    const addr = ethers.getAddress(payee);
    const rec = this.payees.get(addr);
    return Boolean(rec && rec.active && rec.identityHash === expectedIdentityHash);
  }

  _enforcePayeeConfirmation(payee, expectedIdentityHash) {
    if (expectedIdentityHash && expectedIdentityHash !== ethers.ZeroHash) {
      if (!this.verifyPayee(payee, expectedIdentityHash)) {
        throw new Error(`PayeeConfirmationFailed: ${payee} does not match ${expectedIdentityHash}`);
      }
    }
  }

  // =========================================================================
  // Module 1: Per-Second tUSD8 Streaming
  // =========================================================================

  createStream({
    sender,
    recipient,
    deposit,
    startTime = 0,
    cliffDuration = 0,
    duration,
    cancelable = true,
    expectedPayeeHash = ethers.ZeroHash,
    memo = "Payroll Stream",
  }) {
    const senderAddr = ethers.getAddress(sender);
    const recipientAddr = ethers.getAddress(recipient);
    if (senderAddr === recipientAddr) throw new Error("InvalidAddress: self-stream not allowed");

    const dep = BigInt(deposit);
    if (dep <= 0n) throw new Error("InvalidAmount: deposit must be > 0");
    if (duration <= 0 || cliffDuration > duration) {
      throw new Error("InvalidTimeRange");
    }

    this._enforcePayeeConfirmation(recipientAddr, expectedPayeeHash);
    this._transfer(senderAddr, AEVUM_CONFIG.contracts.tUSD8, dep);

    const actualStart = startTime === 0 ? this.timestamp : Number(startTime);
    const streamId = this.nextStreamId++;
    const memoHash = ethers.keccak256(ethers.toUtf8Bytes(memo));

    const stream = {
      streamId,
      sender: senderAddr,
      recipient: recipientAddr,
      deposit: dep,
      withdrawn: 0n,
      startTime: actualStart,
      cliffTime: actualStart + Number(cliffDuration),
      stopTime: actualStart + Number(duration),
      cancelable: Boolean(cancelable),
      canceled: false,
      memo,
      memoHash,
    };

    this.streams.set(streamId, stream);
    this.totalVolumeLocked += dep;

    this._recordTx("TUSD8PayStream:createStream", senderAddr, {
      streamId,
      recipient: recipientAddr,
      deposit: dep.toString(),
    });
    return stream;
  }

  claimableBalance(streamId) {
    const s = this.streams.get(Number(streamId));
    if (!s || s.canceled) {
      return { claimable: 0n, vested: s ? s.withdrawn : 0n };
    }
    if (this.timestamp < s.cliffTime) {
      return { claimable: 0n, vested: 0n };
    }
    let vested;
    if (this.timestamp >= s.stopTime) {
      vested = s.deposit;
    } else {
      const elapsed = BigInt(this.timestamp - s.startTime);
      const totalDuration = BigInt(s.stopTime - s.startTime);
      vested = (s.deposit * elapsed) / totalDuration;
    }
    const claimable = vested > s.withdrawn ? vested - s.withdrawn : 0n;
    return { claimable, vested };
  }

  withdrawFromStream(caller, streamId, amount = 0n) {
    const s = this.streams.get(Number(streamId));
    if (!s || s.canceled) throw new Error("StreamNotActive");
    const callerAddr = ethers.getAddress(caller);
    if (callerAddr !== s.recipient && callerAddr !== s.sender) {
      throw new Error("Unauthorized");
    }

    const { claimable } = this.claimableBalance(streamId);
    if (claimable === 0n) throw new Error("NothingToWithdraw");

    const req = BigInt(amount);
    const withdrawnAmount = req === 0n || req > claimable ? claimable : req;
    s.withdrawn += withdrawnAmount;

    this.totalVolumeLocked -= withdrawnAmount;
    this.totalVolumeSettled += withdrawnAmount;
    this._transfer(AEVUM_CONFIG.contracts.tUSD8, s.recipient, withdrawnAmount);

    this._recordTx("TUSD8PayStream:withdrawFromStream", callerAddr, {
      streamId,
      recipient: s.recipient,
      withdrawnAmount: withdrawnAmount.toString(),
    });
    return withdrawnAmount;
  }

  cancelStream(caller, streamId) {
    const s = this.streams.get(Number(streamId));
    if (!s || s.canceled) throw new Error("StreamNotActive");
    if (!s.cancelable) throw new Error("Unauthorized: stream is non-cancelable");
    const callerAddr = ethers.getAddress(caller);
    if (callerAddr !== s.sender && callerAddr !== s.recipient) {
      throw new Error("Unauthorized");
    }

    const { claimable: recipientPayout } = this.claimableBalance(streamId);
    const remainingDeposit = s.deposit - s.withdrawn;
    const senderRefund = remainingDeposit - recipientPayout;

    s.canceled = true;
    s.withdrawn += recipientPayout;

    this.totalVolumeLocked -= remainingDeposit;
    this.totalVolumeSettled += recipientPayout;

    if (recipientPayout > 0n) {
      this._transfer(AEVUM_CONFIG.contracts.tUSD8, s.recipient, recipientPayout);
    }
    if (senderRefund > 0n) {
      this._transfer(AEVUM_CONFIG.contracts.tUSD8, s.sender, senderRefund);
    }

    this._recordTx("TUSD8PayStream:cancelStream", callerAddr, {
      streamId,
      senderRefund: senderRefund.toString(),
      recipientPayout: recipientPayout.toString(),
    });
    return { senderRefund, recipientPayout };
  }

  // =========================================================================
  // Module 2: On-Chain Invoicing & Instant Invoice Factoring
  // =========================================================================

  createInvoice({
    merchant,
    payer = ethers.ZeroAddress,
    amount,
    dueAt,
    maxDiscountBps = 500,
    memo = "Enterprise SaaS Invoice",
  }) {
    const merchantAddr = ethers.getAddress(merchant);
    const payerAddr = payer === ethers.ZeroAddress ? ethers.ZeroAddress : ethers.getAddress(payer);
    const amt = BigInt(amount);
    if (amt <= 0n) throw new Error("InvalidAmount");
    if (Number(dueAt) <= this.timestamp) throw new Error("InvalidTimeRange");
    if (Number(maxDiscountBps) > MAX_FACTORING_DISCOUNT_BPS) {
      throw new Error("DiscountExceedsMax");
    }

    const invoiceId = this.nextInvoiceId++;
    const invoice = {
      invoiceId,
      merchant: merchantAddr,
      payer: payerAddr,
      factorLp: ethers.ZeroAddress,
      amount: amt,
      advancePaid: 0n,
      issuedAt: this.timestamp,
      dueAt: Number(dueAt),
      maxDiscountBps: Number(maxDiscountBps),
      status: "Issued",
      memo,
      memoHash: ethers.keccak256(ethers.toUtf8Bytes(memo)),
    };
    this.invoices.set(invoiceId, invoice);

    this._recordTx("TUSD8PayStream:createInvoice", merchantAddr, {
      invoiceId,
      amount: amt.toString(),
      maxDiscountBps,
    });
    return invoice;
  }

  factorInvoice({
    factorLp,
    invoiceId,
    discountBps,
    expectedMerchantHash = ethers.ZeroHash,
  }) {
    const inv = this.invoices.get(Number(invoiceId));
    if (!inv || inv.status !== "Issued") throw new Error("InvoiceNotFactorable");
    if (this.timestamp >= inv.dueAt) throw new Error("InvoiceNotFactorable: expired");
    if (Number(discountBps) > inv.maxDiscountBps) {
      throw new Error("DiscountExceedsMax");
    }

    this._enforcePayeeConfirmation(inv.merchant, expectedMerchantHash);

    const lpAddr = ethers.getAddress(factorLp);
    const discount = (inv.amount * BigInt(discountBps)) / BPS_DENOMINATOR;
    const advanceAmount = inv.amount - discount;

    this._transfer(lpAddr, inv.merchant, advanceAmount);

    inv.factorLp = lpAddr;
    inv.advancePaid = advanceAmount;
    inv.status = "Factored";
    this.totalVolumeSettled += advanceAmount;

    this._recordTx("TUSD8PayStream:factorInvoice", lpAddr, {
      invoiceId,
      merchant: inv.merchant,
      advanceAmount: advanceAmount.toString(),
      discountBps,
    });
    return advanceAmount;
  }

  payInvoice({
    payer,
    invoiceId,
    expectedMerchantHash = ethers.ZeroHash,
    resourceReceiptHash = ethers.ZeroHash,
  }) {
    const inv = this.invoices.get(Number(invoiceId));
    if (!inv || (inv.status !== "Issued" && inv.status !== "Factored")) {
      throw new Error("InvoiceNotPayable");
    }
    const payerAddr = ethers.getAddress(payer);
    if (inv.payer !== ethers.ZeroAddress && inv.payer !== payerAddr) {
      throw new Error("Unauthorized: caller is not designated invoice payer");
    }

    this._enforcePayeeConfirmation(inv.merchant, expectedMerchantHash);

    const settlementRecipient =
      inv.status === "Factored" ? inv.factorLp : inv.merchant;

    this._transfer(payerAddr, settlementRecipient, inv.amount);
    inv.status = "Paid";
    this.totalVolumeSettled += inv.amount;

    this._recordTx("TUSD8PayStream:payInvoice", payerAddr, {
      invoiceId,
      settlementRecipient,
      amount: inv.amount.toString(),
    });
    return inv;
  }

  // =========================================================================
  // Module 3: Atomic Milestone Escrow
  // =========================================================================

  createEscrow({
    client,
    provider,
    arbiter,
    amount,
    deadline,
    expectedPayeeHash = ethers.ZeroHash,
    expectedDeliverableHash,
  }) {
    const clientAddr = ethers.getAddress(client);
    const providerAddr = ethers.getAddress(provider);
    const arbiterAddr = ethers.getAddress(arbiter);
    const amt = BigInt(amount);
    if (amt <= 0n || !expectedDeliverableHash || expectedDeliverableHash === ethers.ZeroHash) {
      throw new Error("InvalidAmount");
    }
    if (Number(deadline) <= this.timestamp) throw new Error("InvalidTimeRange");

    this._enforcePayeeConfirmation(providerAddr, expectedPayeeHash);
    this._transfer(clientAddr, AEVUM_CONFIG.contracts.tUSD8, amt);

    const escrowId = this.nextEscrowId++;
    const escrow = {
      escrowId,
      client: clientAddr,
      provider: providerAddr,
      arbiter: arbiterAddr,
      amount: amt,
      deadline: Number(deadline),
      status: "Funded",
      expectedDeliverableHash,
      submittedDeliverableHash: null,
    };
    this.escrows.set(escrowId, escrow);
    this.totalVolumeLocked += amt;

    this._recordTx("TUSD8PayStream:createEscrow", clientAddr, {
      escrowId,
      provider: providerAddr,
      amount: amt.toString(),
    });
    return escrow;
  }

  releaseEscrow({ caller, escrowId, actualDeliverableHash }) {
    const e = this.escrows.get(Number(escrowId));
    if (!e || e.status !== "Funded") throw new Error("EscrowNotFunded");
    const callerAddr = ethers.getAddress(caller);
    if (callerAddr !== e.client && callerAddr !== e.arbiter) {
      throw new Error("Unauthorized");
    }
    if (actualDeliverableHash !== e.expectedDeliverableHash) {
      throw new Error("DeliverableHashMismatch");
    }

    e.submittedDeliverableHash = actualDeliverableHash;
    e.status = "Released";
    this.totalVolumeLocked -= e.amount;
    this.totalVolumeSettled += e.amount;

    this._transfer(AEVUM_CONFIG.contracts.tUSD8, e.provider, e.amount);

    this._recordTx("TUSD8PayStream:releaseEscrow", callerAddr, {
      escrowId,
      provider: e.provider,
      amount: e.amount.toString(),
    });
    return e;
  }

  refundExpiredEscrow({ caller, escrowId }) {
    const e = this.escrows.get(Number(escrowId));
    if (!e || e.status !== "Funded") throw new Error("EscrowNotFunded");
    if (this.timestamp <= e.deadline) throw new Error("EscrowDeadlineNotReached");
    const callerAddr = ethers.getAddress(caller);
    if (callerAddr !== e.client && callerAddr !== e.arbiter) {
      throw new Error("Unauthorized");
    }

    e.status = "Refunded";
    this.totalVolumeLocked -= e.amount;
    this._transfer(AEVUM_CONFIG.contracts.tUSD8, e.client, e.amount);

    this._recordTx("TUSD8PayStream:refundExpiredEscrow", callerAddr, {
      escrowId,
      client: e.client,
      amount: e.amount.toString(),
    });
    return e;
  }

  // =========================================================================
  // Module 4: Scoped AI Agent Session Keys & Spend Guardrails
  // =========================================================================

  authorizeSessionKey({
    owner,
    sessionKey,
    maxSinglePayment,
    maxDailySpend,
    validUntil,
    requireVerifiedPayee = true,
  }) {
    const ownerAddr = ethers.getAddress(owner);
    const keyAddr = ethers.getAddress(sessionKey);
    const maxSingle = BigInt(maxSinglePayment);
    const maxDaily = BigInt(maxDailySpend);

    if (ownerAddr === keyAddr) throw new Error("InvalidAddress");
    if (maxSingle <= 0n || maxDaily < maxSingle) throw new Error("InvalidAmount");
    if (Number(validUntil) <= this.timestamp) throw new Error("InvalidTimeRange");

    const policy = {
      owner: ownerAddr,
      sessionKey: keyAddr,
      maxSinglePayment: maxSingle,
      maxDailySpend: maxDaily,
      currentWindowSpend: 0n,
      windowStartTs: this.timestamp,
      validUntil: Number(validUntil),
      requireVerifiedPayee: Boolean(requireVerifiedPayee),
      active: true,
    };
    this.sessionPolicies.set(`${ownerAddr}:${keyAddr}`, policy);

    this._recordTx("TUSD8PayStream:authorizeSessionKey", ownerAddr, {
      sessionKey: keyAddr,
      maxSinglePayment: maxSingle.toString(),
      maxDailySpend: maxDaily.toString(),
    });
    return policy;
  }

  revokeSessionKey({ owner, sessionKey }) {
    const ownerAddr = ethers.getAddress(owner);
    const keyAddr = ethers.getAddress(sessionKey);
    const policy = this.sessionPolicies.get(`${ownerAddr}:${keyAddr}`);
    if (policy) {
      policy.active = false;
    }
    this._recordTx("TUSD8PayStream:revokeSessionKey", ownerAddr, {
      sessionKey: keyAddr,
    });
  }

  executeAgentPayment({
    sessionKey,
    owner,
    recipient,
    amount,
    expectedPayeeHash = ethers.ZeroHash,
    x402ResourceHash = ethers.ZeroHash,
  }) {
    const ownerAddr = ethers.getAddress(owner);
    const keyAddr = ethers.getAddress(sessionKey);
    const recipientAddr = ethers.getAddress(recipient);
    const amt = BigInt(amount);

    if (amt <= 0n) throw new Error("InvalidAmount");

    const policy = this.sessionPolicies.get(`${ownerAddr}:${keyAddr}`);
    if (!policy || !policy.active) throw new Error("SessionKeyInactive");
    if (this.timestamp > policy.validUntil) {
      throw new Error("SessionKeyExpired");
    }
    if (amt > policy.maxSinglePayment) {
      throw new Error("ExceedsSessionSinglePaymentCap");
    }

    if (policy.requireVerifiedPayee || expectedPayeeHash !== ethers.ZeroHash) {
      const rec = this.payees.get(recipientAddr);
      const checkHash =
        expectedPayeeHash !== ethers.ZeroHash
          ? expectedPayeeHash
          : rec && rec.active
          ? rec.identityHash
          : ethers.ZeroHash;
      if (checkHash === ethers.ZeroHash || !this.verifyPayee(recipientAddr, checkHash)) {
        throw new Error("PayeeConfirmationFailed");
      }
    }

    if (this.timestamp - policy.windowStartTs >= ROLLING_WINDOW_SECONDS) {
      policy.windowStartTs = this.timestamp;
      policy.currentWindowSpend = 0n;
    }

    const projected = policy.currentWindowSpend + amt;
    if (projected > policy.maxDailySpend) {
      throw new Error("ExceedsSessionDailySpendCap");
    }

    policy.currentWindowSpend = projected;
    this.totalVolumeSettled += amt;
    this._transfer(ownerAddr, recipientAddr, amt);

    this._recordTx("TUSD8PayStream:executeAgentPayment", keyAddr, {
      owner: ownerAddr,
      recipient: recipientAddr,
      amount: amt.toString(),
      x402ResourceHash,
    });
    return policy;
  }
}

/**
 * Queries live on-chain telemetry from the official QDay Aevum Testnet RPC (`https://rpc-test.qday.info`).
 */
async function fetchLiveAevumTelemetry() {
  const provider = new ethers.JsonRpcProvider(AEVUM_CONFIG.rpcUrl, {
    chainId: AEVUM_CONFIG.chainId,
    name: "qday-aevum",
  });

  const [network, blockNumber, tusd8Code, faucetCode] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
    provider.getCode(AEVUM_CONFIG.contracts.tUSD8),
    provider.getCode(AEVUM_CONFIG.contracts.qdayFaucet),
  ]);

  const tusd8Contract = new ethers.Contract(
    AEVUM_CONFIG.contracts.tUSD8,
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function totalSupply() view returns (uint256)",
    ],
    provider
  );

  let symbol = "tUSD8";
  let decimals = 6;
  let totalSupplyFormatted = "0";
  try {
    const [sym, dec, supply] = await Promise.all([
      tusd8Contract.symbol(),
      tusd8Contract.decimals(),
      tusd8Contract.totalSupply(),
    ]);
    symbol = sym;
    decimals = Number(dec);
    totalSupplyFormatted = ethers.formatUnits(supply, decimals);
  } catch {
    // Fallback if proxy view call differs
  }

  return {
    connected: true,
    chainId: Number(network.chainId),
    chainIdHex: "0x" + Number(network.chainId).toString(16).toUpperCase(),
    blockNumber,
    rpcUrl: AEVUM_CONFIG.rpcUrl,
    explorerUrl: AEVUM_CONFIG.explorerUrl,
    tusd8Address: AEVUM_CONFIG.contracts.tUSD8,
    tusd8Deployed: tusd8Code !== "0x",
    tusd8BytecodeSize: (tusd8Code.length - 2) / 2,
    tusd8Symbol: symbol,
    tusd8Decimals: decimals,
    tusd8TotalSupply: totalSupplyFormatted,
    qdayFaucetAddress: AEVUM_CONFIG.contracts.qdayFaucet,
    qdayFaucetDeployed: faucetCode !== "0x",
  };
}

module.exports = {
  AEVUM_CONFIG,
  PayStreamEngine,
  fetchLiveAevumTelemetry,
};
