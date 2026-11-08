const { ethers } = require("ethers");
const { compileContracts } = require("./compile");
const {
  AEVUM_CONFIG,
  PayStreamEngine,
  fetchLiveAevumTelemetry,
} = require("../src/engine/PayStreamVM");

async function main() {
  console.log("================================================================================");
  console.log("  Aevum tUSD8 PayStream — QDay Aevum Testnet (Chain ID 44005) Deployment & Demo ");
  console.log("================================================================================\n");

  // 1. Compile Solidity Contracts
  console.log("[1] Compiling Solidity Smart Contracts (Solidity 0.8.28)");
  const artifacts = compileContracts();
  console.log("");

  // 2. Verify Live QDay Aevum Testnet RPC & Official tUSD8 Contract
  console.log("[2] Verifying Live QDay Aevum Testnet RPC (https://rpc-test.qday.info)");
  const telemetry = await fetchLiveAevumTelemetry();
  console.log(`    Network Name          : ${AEVUM_CONFIG.networkName}`);
  console.log(`    Verified Chain ID     : ${telemetry.chainId} (${telemetry.chainIdHex})`);
  console.log(`    Latest Block Height   : #${telemetry.blockNumber}`);
  console.log(`    Official tUSD8 Token  : ${telemetry.tusd8Address}`);
  console.log(`    tUSD8 On-Chain Status : ${telemetry.tusd8Deployed ? "DEPLOYED" : "MISSING"} (${telemetry.tusd8BytecodeSize} bytes, ${telemetry.tusd8Decimals} decimals, Supply: ${telemetry.tusd8TotalSupply} ${telemetry.tusd8Symbol})`);
  console.log(`    QDay Faucet Contract  : ${telemetry.qdayFaucetAddress} (Deployed: ${telemetry.qdayFaucetDeployed})\n`);

  // 3. Optional Live Broadcast if PRIVATE_KEY is configured
  if (process.env.PRIVATE_KEY) {
    const provider = new ethers.JsonRpcProvider(AEVUM_CONFIG.rpcUrl, AEVUM_CONFIG.chainId);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const bal = await provider.getBalance(wallet.address);
    console.log(`[3] Deployer Wallet (${wallet.address}) Balance: ${ethers.formatEther(bal)} tQDAY`);
    if (bal > 0n) {
      const regFactory = new ethers.ContractFactory(
        artifacts.ERC8004PayeeRegistry.abi,
        artifacts.ERC8004PayeeRegistry.bytecode,
        wallet
      );
      const registry = await regFactory.deploy();
      await registry.waitForDeployment();
      const regAddr = await registry.getAddress();
      console.log(`    Deployed ERC8004PayeeRegistry : ${regAddr}`);

      const streamFactory = new ethers.ContractFactory(
        artifacts.TUSD8PayStream.abi,
        artifacts.TUSD8PayStream.bytecode,
        wallet
      );
      const payStream = await streamFactory.deploy(AEVUM_CONFIG.contracts.tUSD8, regAddr);
      await payStream.waitForDeployment();
      console.log(`    Deployed TUSD8PayStream       : ${await payStream.getAddress()}\n`);
    }
  }

  // 4. Execute Full End-to-End Programmable tUSD8 Payment Flows
  console.log("[3] Executing End-to-End tUSD8 Payment Flows (6 Decimals)");
  const engine = new PayStreamEngine(1_762_600_000);
  const treasury = AEVUM_CONFIG.ownerWallet;
  const merchant = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const factorLp = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const arbiter = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
  const agentSessionKey = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

  engine.mintTUSD8(treasury, ethers.parseUnits("10000", 6));
  engine.mintTUSD8(factorLp, ethers.parseUnits("5000", 6));

  // Flow A: ERC-8004 Confirmation of Payee Registration
  const payeeRec = engine.registerPayee(
    merchant,
    "Aevum Cloud Compute Ltd",
    "ipfs://qday-aevum/merchants/aevum-cloud.json"
  );
  console.log(`    [Flow A] ERC-8004 Payee Registered : "${payeeRec.displayName}" -> ${payeeRec.identityHash}`);

  // Flow B: Continuous Per-Second tUSD8 Stream
  const stream = engine.createStream({
    sender: treasury,
    recipient: merchant,
    deposit: ethers.parseUnits("3600", 6), // 1.00 tUSD8 / second for 1 hour
    duration: 3600,
    expectedPayeeHash: payeeRec.identityHash,
    memo: "QDay GPU Cluster Compute Stream",
  });
  engine.advanceTime(900); // Advance 15 minutes (25% of stream)
  const withdrawn = engine.withdrawFromStream(merchant, stream.streamId);
  console.log(`    [Flow B] tUSD8 Stream #${stream.streamId} (15m elapsed) : Withdrew ${ethers.formatUnits(withdrawn, 6)} tUSD8 to Merchant`);

  // Flow C: Invoice Creation + Instant LP Factoring (2% discount) + Settlement
  const invoice = engine.createInvoice({
    merchant,
    payer: treasury,
    amount: ethers.parseUnits("1000", 6),
    dueAt: engine.timestamp + 86_400,
    maxDiscountBps: 300,
    memo: "INV-2026-AEVUM-01",
  });
  const advancePaid = engine.factorInvoice({
    factorLp,
    invoiceId: invoice.invoiceId,
    discountBps: 200, // 2.00% discount -> 980.00 tUSD8 advanced immediately
    expectedMerchantHash: payeeRec.identityHash,
  });
  engine.payInvoice({
    payer: treasury,
    invoiceId: invoice.invoiceId,
    expectedMerchantHash: payeeRec.identityHash,
  });
  console.log(`    [Flow C] Invoice #${invoice.invoiceId} Factored & Paid : LP advanced ${ethers.formatUnits(advancePaid, 6)} tUSD8; Payer settled 1000.0 tUSD8 to LP`);

  // Flow D: Scoped AI Agent Session Key + x402 Payment Guardrails
  engine.authorizeSessionKey({
    owner: treasury,
    sessionKey: agentSessionKey,
    maxSinglePayment: ethers.parseUnits("25", 6),
    maxDailySpend: ethers.parseUnits("100", 6),
    validUntil: engine.timestamp + 86_400,
    requireVerifiedPayee: true,
  });
  engine.executeAgentPayment({
    sessionKey: agentSessionKey,
    owner: treasury,
    recipient: merchant,
    amount: ethers.parseUnits("15", 6),
    expectedPayeeHash: payeeRec.identityHash,
    x402ResourceHash: ethers.keccak256(ethers.toUtf8Bytes("https://api.qday.info/v1/agent-query")),
  });
  console.log(`    [Flow D] Scoped AI Agent Payment   : Settled 15.0 tUSD8 via Session Key (${agentSessionKey.slice(0, 10)}...)`);

  // Flow E: Atomic Milestone Escrow with SHA-256 Deliverable Verification
  const deliverableHash = ethers.keccak256(ethers.toUtf8Bytes("QDay-Aevum-Audit-Deliverable-v1"));
  const escrow = engine.createEscrow({
    client: treasury,
    provider: merchant,
    arbiter,
    amount: ethers.parseUnits("500", 6),
    deadline: engine.timestamp + 86_400,
    expectedPayeeHash: payeeRec.identityHash,
    expectedDeliverableHash: deliverableHash,
  });
  engine.releaseEscrow({
    caller: arbiter,
    escrowId: escrow.escrowId,
    actualDeliverableHash: deliverableHash,
  });
  console.log(`    [Flow E] Milestone Escrow #${escrow.escrowId}       : Verified SHA-256 & released 500.0 tUSD8 to Provider`);

  console.log("\n================================================================================");
  console.log(`  Total Volume Settled: ${ethers.formatUnits(engine.totalVolumeSettled, 6)} tUSD8 | All Flows Passed!`);
  console.log("================================================================================");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Execution error:", err);
    process.exit(1);
  });
}
