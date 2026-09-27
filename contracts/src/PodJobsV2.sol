// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PodJobsV2: a job that is ready before a pod can start, and an approval that costs something.
/// @notice The poster pays once, for the job and for writing its checks. The job waits, preparing,
///         while the checks are written; nobody can take a seat. The poster reads the checks and
///         approves them, which fixes them and starts the window. Until a seat is taken the poster can
///         take all of it back, less the writings already done.
///
/// A seat that approved work loses its deposit to the poster when a check the pod could see failed on
/// the independent re-run. In every other ending every deposit goes home.
///
/// What this contract does NOT decide: whether the work is any good, or whether the checks were well
/// written. The first comes from the validator's re-run, the second from the poster's own reading.
///
/// It replaces PodJobs for new jobs only. Old jobs stay on the old contract, and numbering continues
/// from it, because titles are numbered by the job's number alone.
contract PodJobsV2 {
    enum Role { Lead, Builder, Reviewer, QA, Security }
    /// @dev new states go last, so the old contract's numbers mean the same here
    enum State { Open, Working, Settled, Refunded, Preparing }
    /// @dev what the validator found. None is only ever the empty record
    enum Verdict { None, Passed, HiddenFailed, VisibleFailed }

    /// @dev the old contract's fields first, in its order; new ones after
    struct Job {
        address poster;
        uint256 price;      // what the pod is paid, without the money for writing the checks
        bytes32 seal;       // the seal of the whole spec, set when the poster approves the checks
        uint64 endsAt;      // set when the poster approves: the window starts then, not at payment
        State state;
        bytes32 commit;     // the commit the seats' approvals are bound to
        uint8 reviewers;    // how many reviewer seats this job has
        uint64 window;      // how long the job stays open once approved, in seconds
    }

    /// @notice the money for writing a job's checks, paid with the job
    struct Writing {
        uint256 balance;    // for writings not yet started
        uint256 reserved;   // the price of the writing under way, if one is
        uint64 reservedAt;
        uint32 kept;        // writings done and charged
    }

    /// @notice what the validator reported, so anybody can check it against the published receipt
    struct Report {
        Verdict verdict;
        bytes32 receiptHash;
    }

    struct Seat {
        address agent;      // the wallet that signs for this seat
        address owner;      // who owns that agent, for the one-owner-one-seat rule
        uint256 deposit;
        bool approved;
    }

    /// @notice shares per role, in percent, in the order of the Role enum. Adds to 100.
    uint8[5] public shares = [20, 40, 15, 15, 10];
    /// @notice a seat's deposit, as a percentage of what that seat is paid
    uint8 public constant DEPOSIT_PERCENT = 10;
    /// @notice reviewer approvals needed. The lead, QA and security are each required outright.
    uint8 public constant REVIEWERS_REQUIRED = 1;
    /// @notice the most reviewer seats a job can have, so paying every seat always fits in one block
    uint8 public constant MAX_REVIEWERS = 5;
    /// @notice writings of the checks paid for with the job; each one after is paid for on its own
    uint8 public constant WRITINGS_INCLUDED = 3;
    /// @notice how long a writing can stay reserved before its poster may release it
    uint64 public constant RESERVATION_TIMEOUT = 1 days;
    /// @notice what the writer's signature over an approval is for, so it can mean nothing else
    bytes32 public constant CHECKS_WRITTEN = keccak256("pod.checks-written.v1");

    /// @notice the only address whose verdict this contract will accept, and where writing money goes
    address public immutable validator;
    /// @notice the address that writes the checks: it reserves, keeps and releases writing money, and
    ///         signs the checks it wrote. It can move no other money.
    address public immutable writer;
    /// @notice what one writing of a job's checks costs, fixed at deployment
    uint256 public immutable writingPrice;
    /// @notice gas sent with every payment. A payee that needs more, or refuses, withdraws instead.
    uint256 public immutable payoutGas;

    uint256 public nextJobId;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => Writing) public writings;
    mapping(uint256 => Report) public reports;
    // jobId => role => index => seat. Reviewers can have several; everyone else has one.
    mapping(uint256 => mapping(uint8 => Seat[])) internal seats;
    // jobId => owner => taken, so one owner cannot hold two seats on the same job
    mapping(uint256 => mapping(address => bool)) public holdsSeat;
    /// @notice payments that did not arrive, kept for their payee to withdraw
    mapping(address => uint256) public owed;
    uint256 public totalOwed;

    event Created(uint256 indexed jobId, address indexed poster, uint256 price, uint64 window, uint256 forWriting);
    event ToppedUp(uint256 indexed jobId, uint256 amount);
    event WritingReserved(uint256 indexed jobId, uint256 amount);
    event WritingKept(uint256 indexed jobId, uint256 amount);
    event WritingReleased(uint256 indexed jobId, uint256 amount, bool toPoster);
    event Opened(uint256 indexed jobId, bytes32 seal, uint64 endsAt, uint256 returnedToPoster);
    event SeatTaken(uint256 indexed jobId, Role role, address indexed agent, address indexed owner, uint256 deposit);
    event Approved(uint256 indexed jobId, Role role, address indexed agent, bytes32 commitHash);
    event LockReleased(uint256 indexed jobId, bytes32 commitHash);
    event Settled(uint256 indexed jobId, bytes32 commitHash, uint256 paid, bytes32 receiptHash);
    event DepositForfeited(uint256 indexed jobId, Role role, address indexed agent, uint256 amount);
    event Refunded(uint256 indexed jobId, uint256 amount, string why);
    event PaymentHeld(address indexed payee, uint256 amount);
    event Withdrawn(address indexed payee, address indexed to, uint256 amount);

    error NotPoster();
    error NotValidator();
    error NotWriter();
    error WrongState();
    error WrongAmount();
    error TooManyReviewers();
    error NoWindow();
    error NotWritten();
    error WritingUnderWay();
    error NoWritingUnderWay();
    error NothingToWriteWith();
    error SeatFilled();
    error OwnerAlreadySeated();
    error NotTheSeat();
    error CommitMismatch();
    error Locked();
    error NotLocked();
    error PolicyNotMet();
    error NoVerdict();
    error TooLate();
    error TooEarly();
    error NothingOwed();
    error PaymentFailed();

    constructor(address validator_, address writer_, uint256 firstJobId, uint256 writingPrice_, uint256 payoutGas_) {
        require(validator_ != address(0) && writer_ != address(0), "bad address");
        require(firstJobId != 0, "jobs are numbered from 1");
        require(writingPrice_ != 0 && payoutGas_ != 0, "bad setting");
        validator = validator_;
        writer = writer_;
        nextJobId = firstJobId;
        writingPrice = writingPrice_;
        payoutGas = payoutGas_;
    }

    // --- preparing ---

    /// @notice Create a job with one payment: its price, and three writings of its checks.
    /// @param window how long the job stays open to a pod once the poster approves its checks
    function post(uint64 window, uint8 reviewers) external payable returns (uint256 jobId) {
        uint256 forWriting = writingPrice * WRITINGS_INCLUDED;
        if (msg.value <= forWriting) revert WrongAmount();
        if (window == 0) revert NoWindow();
        if (reviewers > MAX_REVIEWERS) revert TooManyReviewers();
        jobId = nextJobId++;
        jobs[jobId] = Job({
            poster: msg.sender,
            price: msg.value - forWriting,
            seal: bytes32(0),
            endsAt: 0,
            state: State.Preparing,
            commit: bytes32(0),
            reviewers: reviewers == 0 ? 1 : reviewers,
            window: window
        });
        writings[jobId].balance = forWriting;
        emit Created(jobId, msg.sender, msg.value - forWriting, window, forWriting);
    }

    /// @notice Pay for one more writing, once the three paid with the job are used.
    function topUp(uint256 jobId) external payable {
        Job storage job = jobs[jobId];
        if (msg.sender != job.poster) revert NotPoster();
        if (job.state != State.Preparing) revert WrongState();
        if (msg.value != writingPrice) revert WrongAmount();
        writings[jobId].balance += msg.value;
        emit ToppedUp(jobId, msg.value);
    }

    /// @notice A writing starts: its price is set aside, and neither an approval nor a take-back can
    ///         return it. One writing at a time per job.
    function reserveWriting(uint256 jobId) external {
        if (msg.sender != writer) revert NotWriter();
        if (jobs[jobId].state != State.Preparing) revert WrongState();
        Writing storage writing = writings[jobId];
        if (writing.reserved != 0) revert WritingUnderWay();
        if (writing.balance < writingPrice) revert NothingToWriteWith();
        writing.balance -= writingPrice;
        writing.reserved = writingPrice;
        writing.reservedAt = uint64(block.timestamp);
        emit WritingReserved(jobId, writingPrice);
    }

    /// @notice The writing was done: its price goes to the validator. Works in any state, since a job
    ///         can be approved or taken back while its last writing is under way.
    function keepWriting(uint256 jobId) external {
        if (msg.sender != writer) revert NotWriter();
        Writing storage writing = writings[jobId];
        uint256 amount = writing.reserved;
        if (amount == 0) revert NoWritingUnderWay();
        writing.reserved = 0;
        writing.reservedAt = 0;
        writing.kept += 1;
        emit WritingKept(jobId, amount);
        _pay(validator, amount);
    }

    /// @notice The writing failed on our side, and is not charged. While the job is preparing the money
    ///         goes back to its balance; after that, to the poster. The poster may release a writing
    ///         left reserved for a day, so a writer that stopped can never strand it.
    function releaseWriting(uint256 jobId) external {
        Job storage job = jobs[jobId];
        Writing storage writing = writings[jobId];
        uint256 amount = writing.reserved;
        if (amount == 0) revert NoWritingUnderWay();
        bool isLeftTooLong = msg.sender == job.poster && block.timestamp >= writing.reservedAt + RESERVATION_TIMEOUT;
        if (msg.sender != writer && !isLeftTooLong) revert NotWriter();
        writing.reserved = 0;
        writing.reservedAt = 0;
        bool toPoster = job.state != State.Preparing;
        emit WritingReleased(jobId, amount, toPoster);
        if (toPoster) _pay(job.poster, amount);
        else writing.balance += amount;
    }

    /// @notice What the writer signs to say it wrote the checks a seal fixes, for this job here.
    function checksDigest(uint256 jobId, bytes32 seal) public view returns (bytes32) {
        return keccak256(abi.encode(CHECKS_WRITTEN, address(this), block.chainid, jobId, seal));
    }

    /// @notice The poster approves the checks. The seal is fixed from here, the window starts, and the
    ///         writing money not used goes back. Only a seal the writer signed for this job is taken,
    ///         so a job can never open on checks nobody holds.
    function approveChecks(uint256 jobId, bytes32 seal, bytes calldata writerSignature) external {
        Job storage job = jobs[jobId];
        if (msg.sender != job.poster) revert NotPoster();
        if (job.state != State.Preparing) revert WrongState();
        if (seal == bytes32(0) || _signer(checksDigest(jobId, seal), writerSignature) != writer) revert NotWritten();

        job.seal = seal;
        job.endsAt = uint64(block.timestamp) + job.window;
        job.state = State.Open;
        Writing storage writing = writings[jobId];
        uint256 unused = writing.balance;
        writing.balance = 0;
        emit Opened(jobId, seal, job.endsAt, unused);
        _pay(job.poster, unused);
    }

    /// @notice The poster takes the money back: while preparing, or once open while no seat is taken.
    ///         A writing under way stays reserved, to be kept or released on its own.
    function takeBack(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (msg.sender != job.poster) revert NotPoster();
        if (job.state != State.Preparing && job.state != State.Open) revert WrongState();
        Writing storage writing = writings[jobId];
        uint256 amount = job.price + writing.balance;
        writing.balance = 0;
        job.state = State.Refunded;
        emit Refunded(jobId, amount, "taken back");
        _pay(job.poster, amount);
    }

    // --- open and working ---

    /// @notice What a seat is paid.
    function seatPay(uint256 jobId, Role role) public view returns (uint256) {
        Job storage job = jobs[jobId];
        uint256 whole = (job.price * shares[uint8(role)]) / 100;
        return role == Role.Reviewer ? whole / job.reviewers : whole;
    }

    /// @notice What a seat must put down to hold it.
    function seatDeposit(uint256 jobId, Role role) public view returns (uint256) {
        return (seatPay(jobId, role) * DEPOSIT_PERCENT) / 100;
    }

    /// @notice Take a seat, first come first served, one owner to a job. Never on a job still preparing.
    /// @param owner the human or organisation behind the agent. Kept so a pod cannot be packed.
    function takeSeat(uint256 jobId, Role role, address owner) external payable {
        Job storage job = jobs[jobId];
        if (job.state != State.Open && job.state != State.Working) revert WrongState();
        if (block.timestamp >= job.endsAt) revert TooLate();
        if (holdsSeat[jobId][owner]) revert OwnerAlreadySeated();
        if (msg.value != seatDeposit(jobId, role)) revert WrongAmount();

        Seat[] storage row = seats[jobId][uint8(role)];
        uint256 capacity = role == Role.Reviewer ? job.reviewers : 1;
        if (row.length >= capacity) revert SeatFilled();

        row.push(Seat({ agent: msg.sender, owner: owner, deposit: msg.value, approved: false }));
        holdsSeat[jobId][owner] = true;
        job.state = State.Working;
        emit SeatTaken(jobId, role, msg.sender, owner, msg.value);
    }

    /// @notice Approve the work, as the seat you hold, over one exact commit.
    /// @dev The first approval fixes the commit, and a different commit starts the approvals again.
    ///      Once every approval the policy asks for is in place the job is locked on that commit: the
    ///      work is being graded, and nothing else is taken until it settles, the window closes, or the
    ///      validator releases it.
    function approve(uint256 jobId, Role role, bytes32 commitHash) external {
        Job storage job = jobs[jobId];
        if (job.state != State.Working) revert WrongState();
        if (block.timestamp >= job.endsAt) revert TooLate();
        if (commitHash == bytes32(0)) revert CommitMismatch();

        if (job.commit != commitHash) {
            if (job.commit != bytes32(0)) {
                if (policyMet(jobId, job.commit)) revert Locked();
                _clearApprovals(jobId);
            }
            job.commit = commitHash;
        }

        _seatOf(jobId, role, msg.sender).approved = true;
        emit Approved(jobId, role, msg.sender, commitHash);
    }

    /// @notice Whether every approval the policy asks for is in place, on the commit given.
    function policyMet(uint256 jobId, bytes32 commitHash) public view returns (bool) {
        Job storage job = jobs[jobId];
        if (job.commit == bytes32(0) || job.commit != commitHash) return false;
        if (!_singleApproved(jobId, Role.Lead)) return false;      // the codeowner, always required
        if (!_singleApproved(jobId, Role.QA)) return false;
        if (!_singleApproved(jobId, Role.Security)) return false;  // nobody is paid without this one
        if (seats[jobId][uint8(Role.Builder)].length == 0) return false;

        uint8 reviewerApprovals;
        Seat[] storage row = seats[jobId][uint8(Role.Reviewer)];
        for (uint256 i; i < row.length; i++) if (row[i].approved) reviewerApprovals++;
        return reviewerApprovals >= REVIEWERS_REQUIRED;
    }

    /// @notice Whether the job is locked on its commit, waiting for its verdict.
    function locked(uint256 jobId) public view returns (bool) {
        return policyMet(jobId, jobs[jobId].commit);
    }

    /// @notice The validator lets go of a locked job it could not grade, or whose runs disagreed. The
    ///         commit and every approval are cleared, so nothing is graded until the pod approves again.
    function releaseLock(uint256 jobId) external {
        if (msg.sender != validator) revert NotValidator();
        Job storage job = jobs[jobId];
        if (job.state != State.Working) revert WrongState();
        if (!locked(jobId)) revert NotLocked();
        bytes32 was = job.commit;
        _clearApprovals(jobId);
        job.commit = bytes32(0);
        emit LockReleased(jobId, was);
    }

    /// @notice The validator reports an independent re-run of the checks on the job's current commit,
    ///         and the money moves.
    /// @dev A pass pays the pod, and the poster gets whatever the shares leave. A failure refunds the
    ///      poster; the seats that approved lose their deposits to the poster only when a check the pod
    ///      could see failed. The contract never decides quality itself.
    function settle(uint256 jobId, bytes32 commitHash, Verdict verdict, bytes32 receiptHash) external {
        if (msg.sender != validator) revert NotValidator();
        Job storage job = jobs[jobId];
        if (job.state != State.Working) revert WrongState();
        if (block.timestamp >= job.endsAt) revert TooLate();
        if (verdict == Verdict.None) revert NoVerdict();
        if (commitHash == bytes32(0) || commitHash != job.commit) revert CommitMismatch();
        if (!policyMet(jobId, commitHash)) revert PolicyNotMet();

        reports[jobId] = Report({ verdict: verdict, receiptHash: receiptHash });
        if (verdict == Verdict.Passed) _payThePod(jobId, commitHash, receiptHash);
        else _refundAfterFailure(jobId, verdict == Verdict.VisibleFailed);
    }

    /// @notice After the window, anybody may close a job that never settled: the money goes back to
    ///         the poster and every deposit home, since nothing was judged.
    function close(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.state != State.Open && job.state != State.Working) revert WrongState();
        if (block.timestamp < job.endsAt) revert TooEarly();
        job.state = State.Refunded;
        emit Refunded(jobId, job.price, "the window closed with no verdict");
        _returnDeposits(jobId);
        _pay(job.poster, job.price);
    }

    /// @notice Take what a payment could not deliver, to this address or another.
    function withdraw(address to) external {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        totalOwed -= amount;
        bool delivered;
        // no gas cap here, since the payee chose to be called; its answer is still never copied
        assembly { delivered := call(gas(), to, amount, 0, 0, 0, 0) }
        if (!delivered) revert PaymentFailed();
        emit Withdrawn(msg.sender, to, amount);
    }

    function seatAt(uint256 jobId, Role role, uint256 index) external view returns (Seat memory) {
        return seats[jobId][uint8(role)][index];
    }

    function seatCount(uint256 jobId, Role role) external view returns (uint256) {
        return seats[jobId][uint8(role)].length;
    }

    // --- inside ---

    function _payThePod(uint256 jobId, bytes32 commitHash, bytes32 receiptHash) internal {
        Job storage job = jobs[jobId];
        job.state = State.Settled;
        uint256 paid;
        for (uint8 r; r < 5; r++) {
            Seat[] storage row = seats[jobId][r];
            // seatPay already divides the reviewer share by the number of reviewer seats
            uint256 pay = seatPay(jobId, Role(r));
            for (uint256 i; i < row.length; i++) {
                uint256 deposit = row[i].deposit;
                row[i].deposit = 0;
                paid += pay;
                _pay(row[i].agent, pay + deposit);
            }
        }
        emit Settled(jobId, commitHash, paid, receiptHash);
        // what rounding leaves, and the share of any reviewer seat never taken
        _pay(job.poster, job.price - paid);
    }

    function _refundAfterFailure(uint256 jobId, bool isForfeit) internal {
        Job storage job = jobs[jobId];
        job.state = State.Refunded;
        uint256 forfeited;
        for (uint8 r; r < 5; r++) {
            Seat[] storage row = seats[jobId][r];
            for (uint256 i; i < row.length; i++) {
                uint256 deposit = row[i].deposit;
                row[i].deposit = 0;
                if (isForfeit && row[i].approved) {
                    forfeited += deposit;
                    emit DepositForfeited(jobId, Role(r), row[i].agent, deposit);
                } else {
                    _pay(row[i].agent, deposit);
                }
            }
        }
        emit Refunded(jobId, job.price + forfeited, isForfeit ? "a check the pod could see failed" : "only a hidden check failed");
        _pay(job.poster, job.price + forfeited);
    }

    function _returnDeposits(uint256 jobId) internal {
        for (uint8 r; r < 5; r++) {
            Seat[] storage row = seats[jobId][r];
            for (uint256 i; i < row.length; i++) {
                uint256 deposit = row[i].deposit;
                row[i].deposit = 0;
                _pay(row[i].agent, deposit);
            }
        }
    }

    /// @dev Every payment is sent with a fixed amount of gas and its answer is never read, so a payee
    ///      that refuses, burns what it is sent, or answers with a flood of data cannot stop anybody
    ///      else being paid. What does not arrive is kept for the payee to withdraw.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        uint256 gasForPayment = payoutGas;
        bool delivered;
        assembly { delivered := call(gasForPayment, to, amount, 0, 0, 0, 0) }
        if (delivered) return;
        owed[to] += amount;
        totalOwed += amount;
        emit PaymentHeld(to, amount);
    }

    function _seatOf(uint256 jobId, Role role, address agent) internal view returns (Seat storage) {
        Seat[] storage row = seats[jobId][uint8(role)];
        for (uint256 i; i < row.length; i++) if (row[i].agent == agent) return row[i];
        revert NotTheSeat();
    }

    function _singleApproved(uint256 jobId, Role role) internal view returns (bool) {
        Seat[] storage row = seats[jobId][uint8(role)];
        return row.length == 1 && row[0].approved;
    }

    function _clearApprovals(uint256 jobId) internal {
        for (uint8 r; r < 5; r++) {
            Seat[] storage row = seats[jobId][r];
            for (uint256 i; i < row.length; i++) row[i].approved = false;
        }
    }

    /// @dev Who signed a digest, as a wallet signs a message (EIP-191), or nobody for a signature
    ///      that is malformed or could have been made from another. Written out rather than imported:
    ///      the contracts carry no library, as PodToken explains.
    function _signer(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        // the lower half of the curve only, so one signature has one form
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v != 27 && v != 28) return address(0);
        bytes32 signed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        return ecrecover(signed, v, r, s);
    }
}
