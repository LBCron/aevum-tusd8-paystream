const { ethers } = require("ethers");
const { AEVUM_CONFIG, fetchLiveAevumTelemetry } = require("../src/engine/PayStreamVM");

async function interact() {
  console.log("Querying QDay Aevum Testnet (Chain ID 44005) Live State...");
  const telemetry = await fetchLiveAevumTelemetry();
  console.log(JSON.stringify(telemetry, null, 2));

  const provider = new ethers.JsonRpcProvider(AEVUM_CONFIG.rpcUrl, AEVUM_CONFIG.chainId);
  const block = await provider.getBlock("latest");
  console.log("\nLatest Aevum Block Header:");
  console.log(`  Block Number : ${block.number}`);
  console.log(`  Block Hash   : ${block.hash}`);
  console.log(`  Timestamp    : ${new Date(block.timestamp * 1000).toISOString()}`);
  console.log(`  Transactions : ${block.transactions.length}`);
}

if (require.main === module) {
  interact().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
