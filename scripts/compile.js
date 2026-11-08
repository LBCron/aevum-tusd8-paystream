const fs = require("fs");
const path = require("path");
const solc = require("solc");

function compileContracts() {
  const contractsDir = path.join(__dirname, "..", "contracts");
  const files = [
    "ERC8004PayeeRegistry.sol",
    "TUSD8PayStream.sol",
    "MockTUSD8.sol",
  ];

  const sources = {};
  for (const file of files) {
    const fullPath = path.join(contractsDir, file);
    sources[file] = { content: fs.readFileSync(fullPath, "utf8") };
  }

  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    const errors = output.errors.filter((e) => e.severity === "error");
    const warnings = output.errors.filter((e) => e.severity === "warning");
    for (const w of warnings) {
      console.warn("[solc warning]", w.formattedMessage);
    }
    if (errors.length > 0) {
      for (const err of errors) {
        console.error("[solc error]", err.formattedMessage);
      }
      throw new Error(`Solidity compilation failed with ${errors.length} error(s)`);
    }
  }

  const artifacts = {};
  for (const [fileName, fileContracts] of Object.entries(output.contracts)) {
    for (const [contractName, data] of Object.entries(fileContracts)) {
      artifacts[contractName] = {
        contractName,
        sourceName: fileName,
        abi: data.abi,
        bytecode: "0x" + data.evm.bytecode.object,
        deployedBytecode: "0x" + data.evm.deployedBytecode.object,
      };
    }
  }

  const outDir = path.join(__dirname, "..", "artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "contracts.json");
  fs.writeFileSync(outPath, JSON.stringify(artifacts, null, 2));

  console.log("Compiled Solidity contracts successfully:");
  for (const [name, art] of Object.entries(artifacts)) {
    const sizeBytes = (art.bytecode.length - 2) / 2;
    console.log(
      `  - ${name.padEnd(22)} (${art.sourceName}) -> ${sizeBytes} bytes bytecode, ${art.abi.length} ABI entries`
    );
  }
  return artifacts;
}

if (require.main === module) {
  compileContracts();
}

module.exports = { compileContracts };
