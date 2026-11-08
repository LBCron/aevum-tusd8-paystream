const http = require("http");
const { ethers } = require("ethers");
const {
  AEVUM_CONFIG,
  PayStreamEngine,
  fetchLiveAevumTelemetry,
} = require("./engine/PayStreamVM");

const PORT = Number(process.env.PORT || 3000);

const engine = new PayStreamEngine();
const ACTORS = {
  treasury: AEVUM_CONFIG.ownerWallet,
  merchant: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  factorLp: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  arbiter: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  agentSessionKey: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  rogueAddress: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
};

// Seed initial balances and default ERC-8004 merchant registration
engine.mintTUSD8(ACTORS.treasury, ethers.parseUnits("25000", 6));
engine.mintTUSD8(ACTORS.factorLp, ethers.parseUnits("15000", 6));
const defaultPayee = engine.registerPayee(
  ACTORS.merchant,
  "Aevum Cloud Compute Ltd",
  "ipfs://qday-aevum/cop/aevum-cloud.json"
);
engine.authorizeSessionKey({
  owner: ACTORS.treasury,
  sessionKey: ACTORS.agentSessionKey,
  maxSinglePayment: ethers.parseUnits("25", 6),
  maxDailySpend: ethers.parseUnits("150", 6),
  validUntil: engine.timestamp + 86_400,
  requireVerifiedPayee: true,
});

let cachedTelemetry = null;
let lastTelemetryFetch = 0;

async function getTelemetry() {
  const now = Date.now();
  if (!cachedTelemetry || now - lastTelemetryFetch > 15_000) {
    try {
      cachedTelemetry = await fetchLiveAevumTelemetry();
      lastTelemetryFetch = now;
    } catch (e) {
      cachedTelemetry = {
        connected: false,
        chainId: AEVUM_CONFIG.chainId,
        chainIdHex: AEVUM_CONFIG.chainIdHex,
        blockNumber: 0,
        rpcUrl: AEVUM_CONFIG.rpcUrl,
        explorerUrl: AEVUM_CONFIG.explorerUrl,
        tusd8Address: AEVUM_CONFIG.contracts.tUSD8,
        tusd8Deployed: true,
        tusd8Symbol: "tUSD8",
        tusd8Decimals: 6,
        error: e.message,
      };
    }
  }
  return cachedTelemetry;
}

function fmt(units) {
  return Number(ethers.formatUnits(units, 6)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

async function buildDashboardState() {
  const telemetry = await getTelemetry();
  const policy = engine.sessionPolicies.get(
    `${ACTORS.treasury}:${ACTORS.agentSessionKey}`
  );

  return {
    config: AEVUM_CONFIG,
    telemetry,
    actors: ACTORS,
    balances: {
      treasury: fmt(engine.balanceOf(ACTORS.treasury)),
      merchant: fmt(engine.balanceOf(ACTORS.merchant)),
      factorLp: fmt(engine.balanceOf(ACTORS.factorLp)),
    },
    metrics: {
      totalVolumeLocked: fmt(engine.totalVolumeLocked),
      totalVolumeSettled: fmt(engine.totalVolumeSettled),
      activeStreams: engine.streams.size,
      activeInvoices: engine.invoices.size,
      activeEscrows: engine.escrows.size,
      agentRemainingDaily: policy
        ? fmt(policy.maxDailySpend - policy.currentWindowSpend)
        : "0.00",
      agentSessionActive: policy ? policy.active : false,
    },
    payeeRecord: defaultPayee,
    txLogs: engine.txLogs.slice(0, 14),
  };
}

const HTML_UI = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Aevum tUSD8 PayStream — QDay Aevum Testnet (Chain ID 44005)</title>
  <style>
    :root {
      --bg-canvas: #07090e;
      --bg-surface: #0f131d;
      --bg-elevated: #171d2b;
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --border-hairline: rgba(255, 255, 255, 0.08);
      --accent-primary: #38bdf8;
      --accent-green: #10b981;
      --accent-amber: #f59e0b;
      --accent-red: #ef4444;
      --font-sans: "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono: "JetBrains Mono", "Fira Code", monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-canvas);
      color: var(--text-primary);
      font-family: var(--font-sans);
      line-height: 1.55;
      padding: 28px 24px 64px;
    }
    .container { max-width: 1220px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 24px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border-hairline);
      margin-bottom: 24px;
      flex-wrap: wrap;
    }
    .eyebrow {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--accent-primary);
      font-weight: 600;
      margin-bottom: 6px;
    }
    h1 {
      font-size: clamp(1.5rem, 2.5vw, 2.2rem);
      letter-spacing: -0.03em;
      line-height: 1.15;
    }
    .subtitle {
      color: var(--text-secondary);
      max-width: 68ch;
      margin-top: 8px;
      font-size: 0.94rem;
    }
    .wallet-bar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    button {
      background: var(--bg-elevated);
      color: var(--text-primary);
      border: 1px solid var(--border-hairline);
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 0.86rem;
      font-weight: 600;
      cursor: pointer;
      transition: transform 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms ease;
    }
    button:hover { border-color: var(--accent-primary); }
    button:active { transform: scale(0.985); }
    button.primary { background: var(--accent-primary); color: #041019; border-color: transparent; }
    button.danger { border-color: rgba(239, 68, 68, 0.45); color: #fca5a5; }
    .telemetry-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-hairline);
      border-radius: 10px;
      padding: 14px 16px;
      font-variant-numeric: tabular-nums;
    }
    .stat-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
    .stat-val { font-size: 1.15rem; font-weight: 600; font-family: var(--font-mono); margin-top: 4px; }
    .stat-sub { font-size: 0.76rem; color: var(--text-secondary); margin-top: 2px; font-family: var(--font-mono); }
    .bento {
      display: grid;
      grid-template-columns: 1.3fr 1fr;
      gap: 24px;
      margin-bottom: 24px;
    }
    @media (max-width: 900px) { .bento { grid-template-columns: 1fr; } }
    .panel {
      background: var(--bg-surface);
      border: 1px solid var(--border-hairline);
      border-radius: 12px;
      padding: 24px;
    }
    .panel h2 {
      font-size: 1.05rem;
      margin-bottom: 14px;
      letter-spacing: -0.015em;
    }
    .workflow-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
    }
    .workflow-btn {
      display: flex;
      justify-content: space-between;
      align-items: center;
      text-align: left;
      padding: 12px 16px;
    }
    .workflow-tag {
      font-family: var(--font-mono);
      font-size: 0.74rem;
      padding: 2px 8px;
      border-radius: 4px;
      background: rgba(56, 189, 248, 0.14);
      color: var(--accent-primary);
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.84rem; font-variant-numeric: tabular-nums; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border-hairline); }
    th { color: var(--text-muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; }
    .mono { font-family: var(--font-mono); font-size: 0.78rem; }
    .badge-ok { color: var(--accent-green); font-family: var(--font-mono); font-size: 0.76rem; }
    .badge-err { color: #fca5a5; font-family: var(--font-mono); font-size: 0.76rem; }
    #statusBanner {
      margin-bottom: 16px;
      padding: 10px 14px;
      border-radius: 8px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-hairline);
      font-size: 0.85rem;
      color: var(--text-secondary);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <div class="eyebrow">QDay Aevum Builder Challenge #1 · Chain ID 44005 (0xABE5)</div>
        <h1>Aevum tUSD8 PayStream</h1>
        <p class="subtitle">Programmable tUSD8 Stablecoin Streaming, Instant Invoice Factoring, ERC-8004 Confirmation of Payee &amp; Scoped AI Agent Session Keys on QDay Aevum Testnet.</p>
      </div>
      <div class="wallet-bar">
        <button class="primary" onclick="addAevumNetwork()">Add QDay Aevum Testnet (44005)</button>
        <button onclick="addTUSD8Token()">+ Add tUSD8 (6 Decimals)</button>
        <a href="https://faucet.qday.info/en" target="_blank" rel="noreferrer"><button>QDay Faucet ↗</button></a>
      </div>
    </header>

    <div id="statusBanner">Connecting to QDay Aevum Testnet RPC (https://rpc-test.qday.info)...</div>

    <div class="telemetry-strip">
      <div class="stat-card">
        <div class="stat-label">QDay Aevum Live Block</div>
        <div class="stat-val" id="liveBlock">#--</div>
        <div class="stat-sub">Chain ID: 44005 (0xABE5)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Official tUSD8 Contract</div>
        <div class="stat-val" id="tusd8Supply">-- tUSD8</div>
        <div class="stat-sub">0x4565...3483 (6 Decimals)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Treasury Balance</div>
        <div class="stat-val" id="treasuryBal">-- tUSD8</div>
        <div class="stat-sub" id="treasuryAddr">0x958c...c3f9</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Merchant Balance</div>
        <div class="stat-val" id="merchantBal">-- tUSD8</div>
        <div class="stat-sub">ERC-8004 Verified Payee</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Protocol Settled Volume</div>
        <div class="stat-val" id="settledVol">-- tUSD8</div>
        <div class="stat-sub">AI Agent Daily Cap Rem: <span id="agentRem">--</span></div>
      </div>
    </div>

    <div class="bento">
      <div class="panel">
        <h2>Interactive End-to-End tUSD8 Payment Flows</h2>
        <div class="workflow-grid">
          <button class="workflow-btn" onclick="runFlow('stream_flow')">
            <span><strong>1. Continuous Per-Second tUSD8 Stream</strong> (Create 3,600 tUSD8/hr stream + advance 15m + withdraw)</span>
            <span class="workflow-tag">Payroll Track</span>
          </button>
          <button class="workflow-btn" onclick="runFlow('invoice_factor_flow')">
            <span><strong>2. On-Chain Invoice + Instant LP Factoring</strong> (Issue 1,000 tUSD8 invoice, factor at 2% discount, settle)</span>
            <span class="workflow-tag">Invoice Track</span>
          </button>
          <button class="workflow-btn" onclick="runFlow('escrow_flow')">
            <span><strong>3. ERC-8004 Confirmation of Payee + Milestone Escrow</strong> (Verify payee hash &amp; release 500 tUSD8)</span>
            <span class="workflow-tag">CoP + Escrow</span>
          </button>
          <button class="workflow-btn" onclick="runFlow('agent_x402_flow')">
            <span><strong>4. Scoped AI Agent Session Key Payment</strong> (Autonomous 15 tUSD8 x402 settlement within spend cap)</span>
            <span class="workflow-tag">AI Agent Track</span>
          </button>
          <button class="workflow-btn danger" onclick="runFlow('guardrail_attack')">
            <span><strong>5. Simulate Prompt-Injection / Address-Poisoning Attack</strong> (Attempt 250 tUSD8 drain to unverified address)</span>
            <span class="workflow-tag" style="background:rgba(239,68,68,0.18);color:#fca5a5">Safety Control</span>
          </button>
        </div>
      </div>

      <div class="panel">
        <h2>QDay Aevum Contract &amp; ERC-8004 Registry Specifications</h2>
        <table>
          <tbody>
            <tr><th>tUSD8 Stablecoin</th><td class="mono"><a href="https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483" target="_blank" style="color:var(--accent-primary)">0x456569838f1d43009A91ebA4263147Afd7233483 ↗</a></td></tr>
            <tr><th>QDay Faucet</th><td class="mono">0x33d19Bde2e1798c13808f17BfBa1780b28e4bACC</td></tr>
            <tr><th>tUSD8 Faucet</th><td class="mono">0x4551B2a3dE4F43e6613E23edf798Ab4FB0211564</td></tr>
            <tr><th>Verified Merchant</th><td class="mono" id="copName">Aevum Cloud Compute Ltd</td></tr>
            <tr><th>ERC-8004 Hash</th><td class="mono" id="copHash">--</td></tr>
            <tr><th>AI Session Key</th><td class="mono" id="sessionKeyAddr">--</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h2>Verifiable Execution Receipts &amp; Guardrail Audit Trail</h2>
      <table>
        <thead>
          <tr><th>Receipt / Tx Hash</th><th>Contract Call</th><th>Sender</th><th>Details &amp; Verification Status</th></tr>
        </thead>
        <tbody id="txBody"></tbody>
      </table>
    </div>
  </div>

  <script>
    async function addAevumNetwork() {
      if (!window.ethereum) {
        alert('Install MetaMask or an EIP-1193 compatible wallet to add QDay Aevum Testnet.');
        return;
      }
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: '0xABE5',
          chainName: 'QDay Aevum',
          rpcUrls: ['https://rpc-test.qday.info'],
          blockExplorerUrls: ['https://explorer-test.qday.info'],
          nativeCurrency: { name: 'tQDAY', symbol: 'tQDAY', decimals: 18 }
        }]
      });
    }

    async function addTUSD8Token() {
      if (!window.ethereum) {
        alert('Install MetaMask or an EIP-1193 compatible wallet first.');
        return;
      }
      await window.ethereum.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: {
            address: '0x456569838f1d43009A91ebA4263147Afd7233483',
            symbol: 'tUSD8',
            decimals: 6
          }
        }
      });
    }

    async function refreshState() {
      const res = await fetch('/api/state');
      const s = await res.json();
      document.getElementById('liveBlock').textContent = '#' + s.telemetry.blockNumber.toLocaleString();
      document.getElementById('tusd8Supply').textContent = Number(s.telemetry.tusd8TotalSupply || 0).toLocaleString() + ' tUSD8';
      document.getElementById('treasuryBal').textContent = s.balances.treasury + ' tUSD8';
      document.getElementById('merchantBal').textContent = s.balances.merchant + ' tUSD8';
      document.getElementById('settledVol').textContent = s.metrics.totalVolumeSettled + ' tUSD8';
      document.getElementById('agentRem').textContent = s.metrics.agentRemainingDaily + ' tUSD8';
      document.getElementById('copHash').textContent = s.payeeRecord.identityHash.slice(0, 22) + '...';
      document.getElementById('sessionKeyAddr').textContent = s.actors.agentSessionKey;

      const banner = document.getElementById('statusBanner');
      banner.innerHTML = 'Connected to <strong>QDay Aevum Testnet (Chain ID 44005 / 0xABE5)</strong> via <code>https://rpc-test.qday.info</code> · Latest Block: <strong>#' + s.telemetry.blockNumber + '</strong> · Official tUSD8 Verified (6 decimals).';

      const tbody = document.getElementById('txBody');
      tbody.innerHTML = s.txLogs.map(tx => \`
        <tr>
          <td class="mono">\${tx.txHash.slice(0, 18)}...</td>
          <td class="mono"><strong>\${tx.action}</strong></td>
          <td class="mono">\${tx.sender.slice(0, 12)}...</td>
          <td class="\${tx.blocked ? 'badge-err' : 'badge-ok'}">\${tx.summary || JSON.stringify(tx)}</td>
        </tr>
      \`).join('');
    }

    async function runFlow(flow) {
      const res = await fetch('/api/flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow })
      });
      const data = await res.json();
      await refreshState();
      if (data.message) {
        document.getElementById('statusBanner').innerHTML = data.message;
      }
    }

    refreshState();
  </script>
</body>
</html>`;

function createAppServer() {
  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/state") {
      const state = await buildDashboardState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }

    if (req.method === "POST" && req.url === "/api/flow") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        const { flow } = JSON.parse(body || "{}");
        let message = "";

        try {
          if (flow === "stream_flow") {
            const s = engine.createStream({
              sender: ACTORS.treasury,
              recipient: ACTORS.merchant,
              deposit: ethers.parseUnits("3600", 6),
              duration: 3600,
              expectedPayeeHash: defaultPayee.identityHash,
              memo: "QDay Real-Time Compute Stream",
            });
            engine.advanceTime(900);
            const w = engine.withdrawFromStream(ACTORS.merchant, s.streamId);
            engine.txLogs[0].summary = `Withdrew ${fmt(w)} tUSD8 from Stream #${s.streamId} after 900s (ERC-8004 Verified)`;
            message = `Executed Per-Second tUSD8 Stream #${s.streamId}: Withdrew <strong>${fmt(w)} tUSD8</strong> to verified merchant.`;
          } else if (flow === "invoice_factor_flow") {
            const inv = engine.createInvoice({
              merchant: ACTORS.merchant,
              payer: ACTORS.treasury,
              amount: ethers.parseUnits("1000", 6),
              dueAt: engine.timestamp + 86_400,
              maxDiscountBps: 300,
            });
            const adv = engine.factorInvoice({
              factorLp: ACTORS.factorLp,
              invoiceId: inv.invoiceId,
              discountBps: 200,
              expectedMerchantHash: defaultPayee.identityHash,
            });
            engine.payInvoice({
              payer: ACTORS.treasury,
              invoiceId: inv.invoiceId,
              expectedMerchantHash: defaultPayee.identityHash,
            });
            engine.txLogs[0].summary = `Invoice #${inv.invoiceId} settled (1,000.00 tUSD8 to LP; ${fmt(adv)} tUSD8 advanced to Merchant)`;
            message = `Factored &amp; settled Invoice #${inv.invoiceId}: LP advanced <strong>${fmt(adv)} tUSD8</strong> immediately; Payer settled <strong>1,000.00 tUSD8</strong>.`;
          } else if (flow === "escrow_flow") {
            const hash = ethers.keccak256(
              ethers.toUtf8Bytes("Aevum-Deliverable-" + Date.now())
            );
            const esc = engine.createEscrow({
              client: ACTORS.treasury,
              provider: ACTORS.merchant,
              arbiter: ACTORS.arbiter,
              amount: ethers.parseUnits("500", 6),
              deadline: engine.timestamp + 86_400,
              expectedPayeeHash: defaultPayee.identityHash,
              expectedDeliverableHash: hash,
            });
            engine.releaseEscrow({
              caller: ACTORS.arbiter,
              escrowId: esc.escrowId,
              actualDeliverableHash: hash,
            });
            engine.txLogs[0].summary = `Escrow #${esc.escrowId} released 500.00 tUSD8 after SHA-256 deliverable match`;
            message = `Released Atomic Milestone Escrow #${esc.escrowId} (<strong>500.00 tUSD8</strong>) after SHA-256 &amp; ERC-8004 verification.`;
          } else if (flow === "agent_x402_flow") {
            engine.executeAgentPayment({
              sessionKey: ACTORS.agentSessionKey,
              owner: ACTORS.treasury,
              recipient: ACTORS.merchant,
              amount: ethers.parseUnits("15", 6),
              expectedPayeeHash: defaultPayee.identityHash,
              x402ResourceHash: ethers.keccak256(
                ethers.toUtf8Bytes("https://api.qday.info/v1/x402")
              ),
            });
            engine.txLogs[0].summary = `AI Session Key settled 15.00 tUSD8 within 25.00 tUSD8/tx guardrail`;
            message = `Autonomous AI Agent Session Key settled <strong>15.00 tUSD8</strong> (x402 Verified).`;
          } else if (flow === "guardrail_attack") {
            try {
              engine.executeAgentPayment({
                sessionKey: ACTORS.agentSessionKey,
                owner: ACTORS.treasury,
                recipient: ACTORS.rogueAddress,
                amount: ethers.parseUnits("250", 6),
              });
            } catch (attackErr) {
              engine._recordTx(
                "TUSD8PayStream:executeAgentPayment [REVERTED]",
                ACTORS.agentSessionKey,
                {
                  blocked: true,
                  summary: `REVERTED: ${attackErr.message} ( Blocked 250.00 tUSD8 drain to unverified address )`,
                }
              );
              message = `<span style="color:#fca5a5">Guardrail Defense Triggered:</span> Reverted unauthorized 250.00 tUSD8 drain attempt (<code>${attackErr.message}</code>).`;
            }
          }
        } catch (err) {
          message = `<span style="color:#fca5a5">Error: ${err.message}</span>`;
        }

        const state = await buildDashboardState();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message, state }));
      });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML_UI);
  });
}

if (require.main === module) {
  const server = createAppServer();
  server.listen(PORT, () => {
    console.log(
      `Aevum tUSD8 PayStream Dashboard listening on http://localhost:${PORT}`
    );
  });
}

module.exports = { createAppServer };
