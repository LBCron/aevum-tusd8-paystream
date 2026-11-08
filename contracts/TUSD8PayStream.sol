// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ERC8004PayeeRegistry.sol";

interface IERC20Decimals {
    function totalSupply() external view returns (uint256);
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/**
 * @title TUSD8PayStream
 * @author Ronan Chen Lopes (@LBCron)
 * @notice Programmable tUSD8 Stablecoin Streaming, Instant Invoice Factoring, Atomic Milestone Escrow,
 *         ERC-8004 Confirmation of Payee, and Scoped AI Agent Session Keys on QDay Aevum Testnet (Chain ID 44005).
 * @dev Official QDay Aevum tUSD8 token address: 0x456569838f1d43009A91ebA4263147Afd7233483 (6 decimals).
 */
contract TUSD8PayStream {
    /// @notice Official QDay Aevum Testnet Chain ID (44005 / 0xABE5)
    uint256 public constant AEVUM_TESTNET_CHAIN_ID = 44005;

    /// @notice Official QDay Aevum Testnet tUSD8 Contract Address (6 decimals)
    address public constant OFFICIAL_TUSD8_ADDRESS = 0x456569838f1d43009A91ebA4263147Afd7233483;

    /// @notice Rolling window duration for AI Agent Session Key daily spend limits (24 hours)
    uint64 public constant ROLLING_WINDOW_SECONDS = 86_400;

    /// @notice Basis points denominator (100% = 10,000 bps)
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Maximum allowed invoice factoring discount (25% = 2,500 bps)
    uint16 public constant MAX_FACTORING_DISCOUNT_BPS = 2_500;

    /// @notice Underlying stablecoin token (tUSD8 on QDay Aevum Testnet)
    IERC20Decimals public immutable tusd8;

    /// @notice ERC-8004 Confirmation of Payee Registry
    IERC8004PayeeRegistry public immutable payeeRegistry;

    /// @dev Simple reentrancy guard state
    uint256 private _unlocked = 1;

    modifier nonReentrant() {
        if (_unlocked != 1) revert ReentrancyBlocked();
        _unlocked = 2;
        _;
        _unlocked = 1;
    }

    // =========================================================================
    // Data Structures
    // =========================================================================

    struct Stream {
        address sender;
        address recipient;
        uint128 deposit;
        uint128 withdrawn;
        uint64 startTime;
        uint64 cliffTime;
        uint64 stopTime;
        bool cancelable;
        bool canceled;
        bytes32 memoHash;
    }

    enum InvoiceStatus {
        None,
        Issued,
        Factored,
        Paid,
        Canceled
    }

    struct Invoice {
        address merchant;
        address payer;
        address factorLp;
        uint128 amount;
        uint128 advancePaid;
        uint64 issuedAt;
        uint64 dueAt;
        uint16 maxDiscountBps;
        InvoiceStatus status;
        bytes32 memoHash;
    }

    enum EscrowStatus {
        None,
        Funded,
        Released,
        Refunded
    }

    struct MilestoneEscrow {
        address client;
        address provider;
        address arbiter;
        uint128 amount;
        uint64 deadline;
        EscrowStatus status;
        bytes32 expectedDeliverableHash;
        bytes32 submittedDeliverableHash;
    }

    struct AgentSessionPolicy {
        uint128 maxSinglePayment;
        uint128 maxDailySpend;
        uint128 currentWindowSpend;
        uint64 windowStartTs;
        uint64 validUntil;
        bool requireVerifiedPayee;
        bool active;
    }

    // =========================================================================
    // State Variables
    // =========================================================================

    uint256 public nextStreamId = 1;
    uint256 public nextInvoiceId = 1;
    uint256 public nextEscrowId = 1;

    uint256 public totalVolumeLocked;
    uint256 public totalVolumeSettled;

    mapping(uint256 => Stream) public streams;
    mapping(uint256 => Invoice) public invoices;
    mapping(uint256 => MilestoneEscrow) public escrows;

    /// @notice Mapping of `owner => agentSessionKey => AgentSessionPolicy`
    mapping(address => mapping(address => AgentSessionPolicy)) public sessionPolicies;

    // =========================================================================
    // Events
    // =========================================================================

    event StreamCreated(
        uint256 indexed streamId,
        address indexed sender,
        address indexed recipient,
        uint128 deposit,
        uint64 startTime,
        uint64 cliffTime,
        uint64 stopTime,
        bytes32 memoHash
    );
    event StreamWithdrawn(
        uint256 indexed streamId,
        address indexed recipient,
        uint128 amount
    );
    event StreamCanceled(
        uint256 indexed streamId,
        address indexed sender,
        address indexed recipient,
        uint128 senderRefund,
        uint128 recipientPayout
    );

    event InvoiceCreated(
        uint256 indexed invoiceId,
        address indexed merchant,
        address indexed payer,
        uint128 amount,
        uint64 dueAt,
        uint16 maxDiscountBps,
        bytes32 memoHash
    );
    event InvoiceFactored(
        uint256 indexed invoiceId,
        address indexed merchant,
        address indexed factorLp,
        uint128 invoiceAmount,
        uint128 advancePaid,
        uint16 discountBps
    );
    event InvoicePaid(
        uint256 indexed invoiceId,
        address indexed payer,
        address indexed settlementRecipient,
        uint128 amount,
        bytes32 resourceReceiptHash
    );

    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed client,
        address indexed provider,
        address arbiter,
        uint128 amount,
        uint64 deadline,
        bytes32 expectedDeliverableHash
    );
    event EscrowReleased(
        uint256 indexed escrowId,
        address indexed provider,
        address indexed verifier,
        uint128 amount,
        bytes32 deliverableHash
    );
    event EscrowRefunded(
        uint256 indexed escrowId,
        address indexed client,
        uint128 amount
    );

    event SessionKeyAuthorized(
        address indexed owner,
        address indexed sessionKey,
        uint128 maxSinglePayment,
        uint128 maxDailySpend,
        uint64 validUntil,
        bool requireVerifiedPayee
    );
    event SessionKeyRevoked(address indexed owner, address indexed sessionKey);
    event AgentPaymentExecuted(
        address indexed owner,
        address indexed sessionKey,
        address indexed recipient,
        uint128 amount,
        bytes32 x402ResourceHash
    );

    // =========================================================================
    // Custom Errors
    // =========================================================================

    error ReentrancyBlocked();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidTimeRange();
    error TransferFailed();
    error PayeeConfirmationFailed(address payee, bytes32 expectedIdentityHash);
    error Unauthorized();
    error StreamNotActive();
    error NothingToWithdraw();
    error InvoiceNotPayable();
    error InvoiceNotFactorable();
    error DiscountExceedsMax(uint16 requestedBps, uint16 maxBps);
    error EscrowNotFunded();
    error DeliverableHashMismatch(bytes32 expectedHash, bytes32 actualHash);
    error EscrowDeadlineNotReached();
    error SessionKeyInactive();
    error SessionKeyExpired(uint64 validUntil, uint64 currentTs);
    error ExceedsSessionSinglePaymentCap(uint128 requested, uint128 maxAllowed);
    error ExceedsSessionDailySpendCap(uint128 projectedSpend, uint128 dailyCap);

    // =========================================================================
    // Constructor
    // =========================================================================

    constructor(address _tusd8, address _payeeRegistry) {
        if (_tusd8 == address(0) || _payeeRegistry == address(0)) revert InvalidAddress();
        tusd8 = IERC20Decimals(_tusd8);
        payeeRegistry = IERC8004PayeeRegistry(_payeeRegistry);
    }

    // =========================================================================
    // Internal Safe Token Transfer Helpers
    // =========================================================================

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        bool ok = tusd8.transferFrom(from, to, amount);
        if (!ok) revert TransferFailed();
    }

    function _safeTransfer(address to, uint256 amount) internal {
        bool ok = tusd8.transfer(to, amount);
        if (!ok) revert TransferFailed();
    }

    function _enforcePayeeConfirmation(address payee, bytes32 expectedIdentityHash) internal view {
        if (expectedIdentityHash != bytes32(0)) {
            if (!payeeRegistry.verifyPayee(payee, expectedIdentityHash)) {
                revert PayeeConfirmationFailed(payee, expectedIdentityHash);
            }
        }
    }

    // =========================================================================
    // Module 1: Programmable Per-Second tUSD8 Streaming (Payroll & Subscriptions)
    // =========================================================================

    /**
     * @notice Creates a continuous per-second tUSD8 payment stream with optional ERC-8004 Confirmation of Payee.
     */
    function createStream(
        address recipient,
        uint128 deposit,
        uint64 startTime,
        uint64 cliffDuration,
        uint64 duration,
        bool cancelable,
        bytes32 expectedPayeeHash,
        bytes32 memoHash
    ) external nonReentrant returns (uint256 streamId) {
        if (recipient == address(0) || recipient == msg.sender) revert InvalidAddress();
        if (deposit == 0) revert InvalidAmount();
        if (duration == 0 || cliffDuration > duration) revert InvalidTimeRange();

        _enforcePayeeConfirmation(recipient, expectedPayeeHash);

        uint64 actualStart = startTime == 0 ? uint64(block.timestamp) : startTime;
        uint64 cliffTime = actualStart + cliffDuration;
        uint64 stopTime = actualStart + duration;

        _safeTransferFrom(msg.sender, address(this), deposit);

        streamId = nextStreamId++;
        streams[streamId] = Stream({
            sender: msg.sender,
            recipient: recipient,
            deposit: deposit,
            withdrawn: 0,
            startTime: actualStart,
            cliffTime: cliffTime,
            stopTime: stopTime,
            cancelable: cancelable,
            canceled: false,
            memoHash: memoHash
        });

        totalVolumeLocked += deposit;

        emit StreamCreated(
            streamId,
            msg.sender,
            recipient,
            deposit,
            actualStart,
            cliffTime,
            stopTime,
            memoHash
        );
    }

    /**
     * @notice Calculates total vested tUSD8 and currently claimable tUSD8 for `streamId`.
     */
    function claimableBalance(uint256 streamId) public view returns (uint128 claimable, uint128 vested) {
        Stream storage s = streams[streamId];
        if (s.sender == address(0) || s.canceled) {
            return (0, s.withdrawn);
        }
        if (block.timestamp < s.cliffTime) {
            return (0, 0);
        }
        if (block.timestamp >= s.stopTime) {
            vested = s.deposit;
        } else {
            uint256 elapsed = block.timestamp - s.startTime;
            uint256 totalDuration = s.stopTime - s.startTime;
            vested = uint128((uint256(s.deposit) * elapsed) / totalDuration);
        }
        claimable = vested > s.withdrawn ? vested - s.withdrawn : 0;
    }

    /**
     * @notice Withdraws accrued tUSD8 from an active stream to the recipient.
     */
    function withdrawFromStream(uint256 streamId, uint128 amount) external nonReentrant returns (uint128 withdrawnAmount) {
        Stream storage s = streams[streamId];
        if (s.sender == address(0) || s.canceled) revert StreamNotActive();
        if (msg.sender != s.recipient && msg.sender != s.sender) revert Unauthorized();

        (uint128 available, ) = claimableBalance(streamId);
        if (available == 0) revert NothingToWithdraw();

        withdrawnAmount = (amount == 0 || amount > available) ? available : amount;
        s.withdrawn += withdrawnAmount;

        totalVolumeLocked -= withdrawnAmount;
        totalVolumeSettled += withdrawnAmount;

        _safeTransfer(s.recipient, withdrawnAmount);

        emit StreamWithdrawn(streamId, s.recipient, withdrawnAmount);
    }

    /**
     * @notice Cancels a cancelable stream, settling vested tUSD8 to the recipient and refunding unvested tUSD8 to the sender.
     */
    function cancelStream(uint256 streamId) external nonReentrant returns (uint128 senderRefund, uint128 recipientPayout) {
        Stream storage s = streams[streamId];
        if (s.sender == address(0) || s.canceled) revert StreamNotActive();
        if (!s.cancelable) revert Unauthorized();
        if (msg.sender != s.sender && msg.sender != s.recipient) revert Unauthorized();

        (recipientPayout, ) = claimableBalance(streamId);
        uint128 remainingDeposit = s.deposit - s.withdrawn;
        senderRefund = remainingDeposit - recipientPayout;

        s.canceled = true;
        s.withdrawn += recipientPayout;

        totalVolumeLocked -= remainingDeposit;
        totalVolumeSettled += recipientPayout;

        if (recipientPayout > 0) {
            _safeTransfer(s.recipient, recipientPayout);
        }
        if (senderRefund > 0) {
            _safeTransfer(s.sender, senderRefund);
        }

        emit StreamCanceled(streamId, s.sender, s.recipient, senderRefund, recipientPayout);
    }

    // =========================================================================
    // Module 2: On-Chain tUSD8 Invoicing & Instant Invoice Factoring
    // =========================================================================

    /**
     * @notice Issues an on-chain tUSD8 invoice that can be settled directly by the payer or factored early by an LP.
     */
    function createInvoice(
        address payer,
        uint128 amount,
        uint64 dueAt,
        uint16 maxDiscountBps,
        bytes32 memoHash
    ) external returns (uint256 invoiceId) {
        if (amount == 0) revert InvalidAmount();
        if (dueAt <= block.timestamp) revert InvalidTimeRange();
        if (maxDiscountBps > MAX_FACTORING_DISCOUNT_BPS) {
            revert DiscountExceedsMax(maxDiscountBps, MAX_FACTORING_DISCOUNT_BPS);
        }

        invoiceId = nextInvoiceId++;
        invoices[invoiceId] = Invoice({
            merchant: msg.sender,
            payer: payer,
            factorLp: address(0),
            amount: amount,
            advancePaid: 0,
            issuedAt: uint64(block.timestamp),
            dueAt: dueAt,
            maxDiscountBps: maxDiscountBps,
            status: InvoiceStatus.Issued,
            memoHash: memoHash
        });

        emit InvoiceCreated(invoiceId, msg.sender, payer, amount, dueAt, maxDiscountBps, memoHash);
    }

    /**
     * @notice Allows a liquidity provider to factor (advance) an unpaid invoice at `discountBps` <= `maxDiscountBps`.
     *         The merchant receives `amount * (10000 - discountBps) / 10000` immediately in tUSD8, and the LP
     *         becomes the beneficiary of the full `amount` when the invoice is paid.
     */
    function factorInvoice(
        uint256 invoiceId,
        uint16 discountBps,
        bytes32 expectedMerchantHash
    ) external nonReentrant returns (uint128 advanceAmount) {
        Invoice storage inv = invoices[invoiceId];
        if (inv.status != InvoiceStatus.Issued) revert InvoiceNotFactorable();
        if (block.timestamp >= inv.dueAt) revert InvoiceNotFactorable();
        if (discountBps > inv.maxDiscountBps) {
            revert DiscountExceedsMax(discountBps, inv.maxDiscountBps);
        }

        _enforcePayeeConfirmation(inv.merchant, expectedMerchantHash);

        uint256 discount = (uint256(inv.amount) * discountBps) / BPS_DENOMINATOR;
        advanceAmount = uint128(uint256(inv.amount) - discount);

        inv.factorLp = msg.sender;
        inv.advancePaid = advanceAmount;
        inv.status = InvoiceStatus.Factored;

        totalVolumeSettled += advanceAmount;

        _safeTransferFrom(msg.sender, inv.merchant, advanceAmount);

        emit InvoiceFactored(invoiceId, inv.merchant, msg.sender, inv.amount, advanceAmount, discountBps);
    }

    /**
     * @notice Pays an issued or factored tUSD8 invoice, verifying the merchant's ERC-8004 Confirmation of Payee hash.
     */
    function payInvoice(
        uint256 invoiceId,
        bytes32 expectedMerchantHash,
        bytes32 resourceReceiptHash
    ) external nonReentrant {
        Invoice storage inv = invoices[invoiceId];
        if (inv.status != InvoiceStatus.Issued && inv.status != InvoiceStatus.Factored) {
            revert InvoiceNotPayable();
        }
        if (inv.payer != address(0) && msg.sender != inv.payer) {
            revert Unauthorized();
        }

        _enforcePayeeConfirmation(inv.merchant, expectedMerchantHash);

        address settlementRecipient = inv.status == InvoiceStatus.Factored
            ? inv.factorLp
            : inv.merchant;

        inv.status = InvoiceStatus.Paid;
        totalVolumeSettled += inv.amount;

        _safeTransferFrom(msg.sender, settlementRecipient, inv.amount);

        emit InvoicePaid(invoiceId, msg.sender, settlementRecipient, inv.amount, resourceReceiptHash);
    }

    // =========================================================================
    // Module 3: Atomic Milestone Escrow with Deliverable Hash Verification
    // =========================================================================

    /**
     * @notice Locks tUSD8 in an atomic milestone escrow gated by SHA-256 deliverable verification.
     */
    function createEscrow(
        address provider,
        address arbiter,
        uint128 amount,
        uint64 deadline,
        bytes32 expectedPayeeHash,
        bytes32 expectedDeliverableHash
    ) external nonReentrant returns (uint256 escrowId) {
        if (provider == address(0) || arbiter == address(0)) revert InvalidAddress();
        if (amount == 0 || expectedDeliverableHash == bytes32(0)) revert InvalidAmount();
        if (deadline <= block.timestamp) revert InvalidTimeRange();

        _enforcePayeeConfirmation(provider, expectedPayeeHash);

        _safeTransferFrom(msg.sender, address(this), amount);

        escrowId = nextEscrowId++;
        escrows[escrowId] = MilestoneEscrow({
            client: msg.sender,
            provider: provider,
            arbiter: arbiter,
            amount: amount,
            deadline: deadline,
            status: EscrowStatus.Funded,
            expectedDeliverableHash: expectedDeliverableHash,
            submittedDeliverableHash: bytes32(0)
        });

        totalVolumeLocked += amount;

        emit EscrowCreated(
            escrowId,
            msg.sender,
            provider,
            arbiter,
            amount,
            deadline,
            expectedDeliverableHash
        );
    }

    /**
     * @notice Releases escrowed tUSD8 to the provider once the client or arbiter verifies `actualDeliverableHash`.
     */
    function releaseEscrow(uint256 escrowId, bytes32 actualDeliverableHash) external nonReentrant {
        MilestoneEscrow storage e = escrows[escrowId];
        if (e.status != EscrowStatus.Funded) revert EscrowNotFunded();
        if (msg.sender != e.client && msg.sender != e.arbiter) revert Unauthorized();
        if (actualDeliverableHash != e.expectedDeliverableHash) {
            revert DeliverableHashMismatch(e.expectedDeliverableHash, actualDeliverableHash);
        }

        e.submittedDeliverableHash = actualDeliverableHash;
        e.status = EscrowStatus.Released;

        totalVolumeLocked -= e.amount;
        totalVolumeSettled += e.amount;

        _safeTransfer(e.provider, e.amount);

        emit EscrowReleased(escrowId, e.provider, msg.sender, e.amount, actualDeliverableHash);
    }

    /**
     * @notice Refunds an expired milestone escrow back to the client if unreleased past `deadline`.
     */
    function refundExpiredEscrow(uint256 escrowId) external nonReentrant {
        MilestoneEscrow storage e = escrows[escrowId];
        if (e.status != EscrowStatus.Funded) revert EscrowNotFunded();
        if (block.timestamp <= e.deadline) revert EscrowDeadlineNotReached();
        if (msg.sender != e.client && msg.sender != e.arbiter) revert Unauthorized();

        e.status = EscrowStatus.Refunded;
        totalVolumeLocked -= e.amount;

        _safeTransfer(e.client, e.amount);

        emit EscrowRefunded(escrowId, e.client, e.amount);
    }

    // =========================================================================
    // Module 4: Scoped AI Agent Session Keys & Spend Guardrails (x402 Ready)
    // =========================================================================

    /**
     * @notice Grants an AI agent session key bounded authority to execute tUSD8 payments on the owner's behalf.
     */
    function authorizeSessionKey(
        address sessionKey,
        uint128 maxSinglePayment,
        uint128 maxDailySpend,
        uint64 validUntil,
        bool requireVerifiedPayee
    ) external {
        if (sessionKey == address(0) || sessionKey == msg.sender) revert InvalidAddress();
        if (maxSinglePayment == 0 || maxDailySpend < maxSinglePayment) revert InvalidAmount();
        if (validUntil <= block.timestamp) revert InvalidTimeRange();

        sessionPolicies[msg.sender][sessionKey] = AgentSessionPolicy({
            maxSinglePayment: maxSinglePayment,
            maxDailySpend: maxDailySpend,
            currentWindowSpend: 0,
            windowStartTs: uint64(block.timestamp),
            validUntil: validUntil,
            requireVerifiedPayee: requireVerifiedPayee,
            active: true
        });

        emit SessionKeyAuthorized(
            msg.sender,
            sessionKey,
            maxSinglePayment,
            maxDailySpend,
            validUntil,
            requireVerifiedPayee
        );
    }

    /**
     * @notice Instantly revokes an AI agent session key.
     */
    function revokeSessionKey(address sessionKey) external {
        sessionPolicies[msg.sender][sessionKey].active = false;
        emit SessionKeyRevoked(msg.sender, sessionKey);
    }

    /**
     * @notice Executes an autonomous AI agent tUSD8 payment signed by `msg.sender` (the scoped session key),
     *         enforcing per-payment caps, 24h rolling spend limits, session expiry, and ERC-8004 payee verification.
     */
    function executeAgentPayment(
        address owner,
        address recipient,
        uint128 amount,
        bytes32 expectedPayeeHash,
        bytes32 x402ResourceHash
    ) external nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        AgentSessionPolicy storage policy = sessionPolicies[owner][msg.sender];
        if (!policy.active) revert SessionKeyInactive();
        if (block.timestamp > policy.validUntil) {
            revert SessionKeyExpired(policy.validUntil, uint64(block.timestamp));
        }
        if (amount > policy.maxSinglePayment) {
            revert ExceedsSessionSinglePaymentCap(amount, policy.maxSinglePayment);
        }

        if (policy.requireVerifiedPayee || expectedPayeeHash != bytes32(0)) {
            bytes32 checkHash = expectedPayeeHash != bytes32(0)
                ? expectedPayeeHash
                : payeeRegistry.getPayeeIdentityHash(recipient);
            if (checkHash == bytes32(0) || !payeeRegistry.verifyPayee(recipient, checkHash)) {
                revert PayeeConfirmationFailed(recipient, checkHash);
            }
        }

        if (block.timestamp - policy.windowStartTs >= ROLLING_WINDOW_SECONDS) {
            policy.windowStartTs = uint64(block.timestamp);
            policy.currentWindowSpend = 0;
        }

        uint128 projected = policy.currentWindowSpend + amount;
        if (projected > policy.maxDailySpend) {
            revert ExceedsSessionDailySpendCap(projected, policy.maxDailySpend);
        }

        policy.currentWindowSpend = projected;
        totalVolumeSettled += amount;

        _safeTransferFrom(owner, recipient, amount);

        emit AgentPaymentExecuted(owner, msg.sender, recipient, amount, x402ResourceHash);
    }
}
