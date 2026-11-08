const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { compileContracts } = require("../scripts/compile");
const {
  AEVUM_CONFIG,
  PayStreamEngine,
  fetchLiveAevumTelemetry,
} = require("../src/engine/PayStreamVM");

describe("Aevum tUSD8 PayStream — Solidity Compilation, Live QDay Aevum RPC & Protocol Suite", () => {
  it("compiles ERC8004PayeeRegistry, TUSD8PayStream, and MockTUSD8 with zero errors", () => {
    const artifacts = compileContracts();
    assert.ok(artifacts.ERC8004PayeeRegistry, "ERC8004PayeeRegistry compiled");
    assert.ok(artifacts.TUSD8PayStream, "TUSD8PayStream compiled");
    assert.ok(artifacts.MockTUSD8, "MockTUSD8 compiled");

    assert.ok(artifacts.TUSD8PayStream.bytecode.length > 2000);
    const iface = new ethers.Interface(artifacts.TUSD8PayStream.abi);
    assert.ok(iface.getFunction("createStream"));
    assert.ok(iface.getFunction("withdrawFromStream"));
    assert.ok(iface.getFunction("cancelStream"));
    assert.ok(iface.getFunction("createInvoice"));
    assert.ok(iface.getFunction("factorInvoice"));
    assert.ok(iface.getFunction("payInvoice"));
    assert.ok(iface.getFunction("createEscrow"));
    assert.ok(iface.getFunction("releaseEscrow"));
    assert.ok(iface.getFunction("authorizeSessionKey"));
    assert.ok(iface.getFunction("executeAgentPayment"));
  });

  it("verifies live QDay Aevum Testnet (Chain ID 44005) RPC and tUSD8 contract deployment", async () => {
    const telemetry = await fetchLiveAevumTelemetry();
    assert.equal(telemetry.chainId, 44005);
    assert.equal(telemetry.chainIdHex, "0xABE5");
    assert.ok(telemetry.blockNumber > 2_000_000);
    assert.equal(
      telemetry.tusd8Address,
      "0x456569838f1d43009A91ebA4263147Afd7233483"
    );
    assert.equal(telemetry.tusd8Deployed, true);
    assert.equal(telemetry.tusd8Decimals, 6);
  });

  it("enforces ERC-8004 Confirmation of Payee registration, collision resistance, and revocation", () => {
    const engine = new PayStreamEngine(1_762_600_000);
    const merchantA = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const imposterB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

    const rec = engine.registerPayee(
      merchantA,
      "QDay Merchant Alpha",
      "ipfs://alpha"
    );
    assert.equal(engine.verifyPayee(merchantA, rec.identityHash), true);
    assert.equal(engine.verifyPayee(imposterB, rec.identityHash), false);

    // Reject duplicate name collision from another address
    assert.throws(() => {
      engine.registerPayee(imposterB, "QDay Merchant Alpha", "ipfs://spoof");
    }, /IdentityHashCollision/);

    // Revoke payee and verify confirmation fails
    engine.revokePayee(merchantA);
    assert.equal(engine.verifyPayee(merchantA, rec.identityHash), false);
  });

  it("streams per-second tUSD8 with cliff enforcement, partial withdrawal, and pro-rata cancellation", () => {
    const engine = new PayStreamEngine(1_762_600_000);
    const sender = AEVUM_CONFIG.ownerWallet;
    const recipient = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

    engine.mintTUSD8(sender, ethers.parseUnits("5000", 6));
    const rec = engine.registerPayee(recipient, "Verified Engineer");

    const stream = engine.createStream({
      sender,
      recipient,
      deposit: ethers.parseUnits("3600", 6), // 1 tUSD8/sec for 3600s
      cliffDuration: 600, // 10 min cliff
      duration: 3600,
      cancelable: true,
      expectedPayeeHash: rec.identityHash,
    });

    // Before cliff (300s): 0 claimable
    engine.advanceTime(300);
    assert.equal(engine.claimableBalance(stream.streamId).claimable, 0n);

    // After cliff (900s = 25%): 900 tUSD8 claimable
    engine.advanceTime(600);
    assert.equal(
      engine.claimableBalance(stream.streamId).claimable,
      ethers.parseUnits("900", 6)
    );

    const withdrawn = engine.withdrawFromStream(
      recipient,
      stream.streamId,
      ethers.parseUnits("400", 6)
    );
    assert.equal(withdrawn, ethers.parseUnits("400", 6));
    assert.equal(engine.balanceOf(recipient), ethers.parseUnits("400", 6));

    // Advance another 900s (total 1800s = 50% vested = 1800 tUSD8; 400 already withdrawn -> 1400 claimable)
    engine.advanceTime(900);
    const { senderRefund, recipientPayout } = engine.cancelStream(
      sender,
      stream.streamId
    );
    assert.equal(recipientPayout, ethers.parseUnits("1400", 6));
    assert.equal(senderRefund, ethers.parseUnits("1800", 6));
    assert.equal(engine.balanceOf(recipient), ethers.parseUnits("1800", 6));
    assert.equal(engine.balanceOf(sender), ethers.parseUnits("3200", 6));
  });

  it("creates tUSD8 invoices, executes instant LP factoring at a discount, and routes payer settlement to LP", () => {
    const engine = new PayStreamEngine(1_762_600_000);
    const payer = AEVUM_CONFIG.ownerWallet;
    const merchant = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const factorLp = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

    engine.mintTUSD8(payer, ethers.parseUnits("2000", 6));
    engine.mintTUSD8(factorLp, ethers.parseUnits("2000", 6));
    const rec = engine.registerPayee(merchant, "Aevum SaaS Vendor");

    const inv = engine.createInvoice({
      merchant,
      payer,
      amount: ethers.parseUnits("1000", 6),
      dueAt: engine.timestamp + 86_400,
      maxDiscountBps: 300, // max 3%
    });

    // Reject discount exceeding merchant's maxDiscountBps
    assert.throws(() => {
      engine.factorInvoice({
        factorLp,
        invoiceId: inv.invoiceId,
        discountBps: 450,
        expectedMerchantHash: rec.identityHash,
      });
    }, /DiscountExceedsMax/);

    // Factor at 200 bps (2% discount) -> merchant receives 980 tUSD8 immediately
    const advance = engine.factorInvoice({
      factorLp,
      invoiceId: inv.invoiceId,
      discountBps: 200,
      expectedMerchantHash: rec.identityHash,
    });
    assert.equal(advance, ethers.parseUnits("980", 6));
    assert.equal(engine.balanceOf(merchant), ethers.parseUnits("980", 6));
    assert.equal(engine.balanceOf(factorLp), ethers.parseUnits("1020", 6));

    // Payer settles 1000 tUSD8 -> routed to factorLp (now has 2020 tUSD8, earning 20 tUSD8 yield)
    engine.payInvoice({
      payer,
      invoiceId: inv.invoiceId,
      expectedMerchantHash: rec.identityHash,
    });
    assert.equal(engine.balanceOf(factorLp), ethers.parseUnits("2020", 6));
    assert.equal(engine.balanceOf(payer), ethers.parseUnits("1000", 6));
  });

  it("enforces SHA-256 deliverable verification on Milestone Escrows and supports expired refunds", () => {
    const engine = new PayStreamEngine(1_762_600_000);
    const client = AEVUM_CONFIG.ownerWallet;
    const provider = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const arbiter = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

    engine.mintTUSD8(client, ethers.parseUnits("1000", 6));
    const rec = engine.registerPayee(provider, "Aevum Smart Contract Auditor");
    const expectedHash = ethers.keccak256(ethers.toUtf8Bytes("audit-report-v1"));

    const escrow = engine.createEscrow({
      client,
      provider,
      arbiter,
      amount: ethers.parseUnits("500", 6),
      deadline: engine.timestamp + 3600,
      expectedPayeeHash: rec.identityHash,
      expectedDeliverableHash: expectedHash,
    });

    // Reject wrong deliverable hash
    assert.throws(() => {
      engine.releaseEscrow({
        caller: arbiter,
        escrowId: escrow.escrowId,
        actualDeliverableHash: ethers.keccak256(ethers.toUtf8Bytes("wrong")),
      });
    }, /DeliverableHashMismatch/);

    // Release with valid hash
    engine.releaseEscrow({
      caller: arbiter,
      escrowId: escrow.escrowId,
      actualDeliverableHash: expectedHash,
    });
    assert.equal(engine.balanceOf(provider), ethers.parseUnits("500", 6));
  });

  it("enforces Scoped AI Agent Session Key per-tx caps, rolling 24h limits, ERC-8004 payee checks, and revocation", () => {
    const engine = new PayStreamEngine(1_762_600_000);
    const owner = AEVUM_CONFIG.ownerWallet;
    const sessionKey = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
    const verifiedMerchant = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const unverifiedRogue = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";

    engine.mintTUSD8(owner, ethers.parseUnits("500", 6));
    const rec = engine.registerPayee(verifiedMerchant, "QDay AI Inference Node");

    engine.authorizeSessionKey({
      owner,
      sessionKey,
      maxSinglePayment: ethers.parseUnits("20", 6),
      maxDailySpend: ethers.parseUnits("35", 6),
      validUntil: engine.timestamp + 86_400,
      requireVerifiedPayee: true,
    });

    // 1. Valid 20 tUSD8 agent payment
    engine.executeAgentPayment({
      sessionKey,
      owner,
      recipient: verifiedMerchant,
      amount: ethers.parseUnits("20", 6),
      expectedPayeeHash: rec.identityHash,
    });
    assert.equal(engine.balanceOf(verifiedMerchant), ethers.parseUnits("20", 6));

    // 2. Reject single payment exceeding 20 tUSD8 cap
    assert.throws(() => {
      engine.executeAgentPayment({
        sessionKey,
        owner,
        recipient: verifiedMerchant,
        amount: ethers.parseUnits("25", 6),
      });
    }, /ExceedsSessionSinglePaymentCap/);

    // 3. Reject payment to unverified rogue address (Confirmation of Payee guardrail)
    assert.throws(() => {
      engine.executeAgentPayment({
        sessionKey,
        owner,
        recipient: unverifiedRogue,
        amount: ethers.parseUnits("10", 6),
      });
    }, /PayeeConfirmationFailed/);

    // 4. Reject payment exceeding 35 tUSD8 daily spend cap (20 + 18 = 38 > 35)
    assert.throws(() => {
      engine.executeAgentPayment({
        sessionKey,
        owner,
        recipient: verifiedMerchant,
        amount: ethers.parseUnits("18", 6),
      });
    }, /ExceedsSessionDailySpendCap/);

    // 5. Revoke session key and verify subsequent calls revert
    engine.revokeSessionKey({ owner, sessionKey });
    assert.throws(() => {
      engine.executeAgentPayment({
        sessionKey,
        owner,
        recipient: verifiedMerchant,
        amount: ethers.parseUnits("5", 6),
      });
    }, /SessionKeyInactive/);
  });
});
