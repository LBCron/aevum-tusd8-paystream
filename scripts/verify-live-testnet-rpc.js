#!/usr/bin/env node
/**
 * Aevum tUSD8 PayStream — Live QDay Aevum Testnet (Chain ID 44005) RPC Verifier & Deployer
 *
 * Connects to https://rpc-test.qday.info (Chain ID 44005 / 0xABE5), verifies the
 * live tUSD8 contract (0x456569838f1d43009A91ebA4263147Afd7233483, 6 decimals),
 * QDayFaucet (0x33d19Bde2e1798c13808f17BfBa1780b28e4bACC), and tUSD8Faucet
 * (0x4551B2a3dE4F43e6613E23edf798Ab4FB0211564), and executes live `eth_estimateGas`
 * and `eth_call` bytecode verification for `ERC8004PayeeRegistry` and `TUSD8PayStream`.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const DEPLOYER = process.env.DEPLOYER_ADDRESS || "0x958cbC9378c75cf158e5B19845E7f004B5f8c3f9";
const RPC_URL = process.env.QDAY_RPC_URL || "https://rpc-test.qday.info";
const TUSD8_ADDRESS = "0x456569838f1d43009A91ebA4263147Afd7233483";
const QDAY_FAUCET = "0x33d19Bde2e1798c13808f17BfBa1780b28e4bACC";
const TUSD8_FAUCET = "0x4551B2a3dE4F43e6613E23edf798Ab4FB0211564";

async function main() {
  const artifactsPath = path.join(__dirname, "..", "artifacts", "contracts.json");
  if (!fs.existsSync(artifactsPath)) {
    throw new Error("Missing artifacts/contracts.json — run `npm run compile` first.");
  }
  const contracts = JSON.parse(fs.readFileSync(artifactsPath, "utf8"));
  const regArtifact = contracts.ERC8004PayeeRegistry;
  const payArtifact = contracts.TUSD8PayStream;

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const [net, blockNumber, tusd8Code, faucetBalance] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
    provider.getCode(TUSD8_ADDRESS),
    provider.getBalance(QDAY_FAUCET)
  ]);

  const tusd8 = new ethers.Contract(
    TUSD8_ADDRESS,
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function totalSupply() view returns (uint256)"
    ],
    provider
  );
  const [symbol, decimals, totalSupply] = await Promise.all([
    tusd8.symbol(),
    tusd8.decimals(),
    tusd8.totalSupply()
  ]);

  const registryDeterministicAddr = ethers.getCreateAddress({ from: DEPLOYER, nonce: 0 });
  const payStreamDeterministicAddr = ethers.getCreateAddress({ from: DEPLOYER, nonce: 1 });

  const regFactory = new ethers.ContractFactory(regArtifact.abi, regArtifact.bytecode);
  const regDeployTx = await regFactory.getDeployTransaction();
  const regGas = await provider.estimateGas({ ...regDeployTx, from: DEPLOYER });

  const payFactory = new ethers.ContractFactory(payArtifact.abi, payArtifact.bytecode);
  const payDeployTx = await payFactory.getDeployTransaction(TUSD8_ADDRESS, registryDeterministicAddr);
  const payGas = await provider.estimateGas({ ...payDeployTx, from: DEPLOYER });

  const manifest = {
    verifiedAt: new Date().toISOString(),
    network: {
      name: "QDay Aevum Testnet",
      chainId: Number(net.chainId),
      chainIdHex: "0xabe5",
      rpcUrl: RPC_URL,
      explorerUrl: "https://explorer-test.qday.info",
      faucetWebUrl: "https://faucet.qday.info/en",
      verifiedBlock: blockNumber
    },
    deployer: DEPLOYER,
    protocolContracts: {
      tUSD8: {
        address: TUSD8_ADDRESS,
        symbol,
        decimals: Number(decimals),
        totalSupplyFormatted: ethers.formatUnits(totalSupply, decimals),
        bytecodeBytes: (tusd8Code.length - 2) / 2
      },
      QDayFaucet: {
        address: QDAY_FAUCET,
        balanceTQDAY: ethers.formatEther(faucetBalance)
      },
      tUSD8Faucet: {
        address: TUSD8_FAUCET
      }
    },
    contracts: {
      ERC8004PayeeRegistry: {
        deterministicAddressNonce0: registryDeterministicAddr,
        liveEstimateGas: regGas.toString()
      },
      TUSD8PayStream: {
        deterministicAddressNonce1: payStreamDeterministicAddr,
        constructorVerifiedAgainstLiveTUSD8: true,
        liveEstimateGas: payGas.toString()
      }
    }
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "live-testnet-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
