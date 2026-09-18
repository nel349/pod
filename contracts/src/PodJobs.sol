// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PodJobs — one job, a pod of seats, and money that only moves when the work is checked.
/// @notice The rules here are the ones nobody should be able to argue with afterwards: who may take
///         a seat, whose approval is required, and what has to be true before anyone is paid.
///
/// What this contract does NOT decide: whether the work is any good. That comes from an independent
/// re-run, reported by a validator, and this contract will not pay without it.
contract PodJobs {
    enum Role { Lead, Builder, Reviewer, QA, Security }
    enum State { Open, Working, Settled, Refunded }

    struct Job {
        address poster;
        uint256 price;      // what the pod is paid, in wei of the chain's own coin
        bytes32 seal;       // the hash the idea was sealed under, published before it opened
        uint64 endsAt;      // nothing settles after this; the poster can take the money back
        State state;
        bytes32 commit;     // the commit the approvals are bound to, set on the first approval
        uint8 reviewers;    // how many reviewer seats this job has
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

    /// @notice the only address whose verdict this contract will accept
    address public immutable validator;

    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;
    // jobId => role => index => seat. Reviewers can have several; everyone else has one.
    mapping(uint256 => mapping(uint8 => Seat[])) internal seats;
    // jobId => owner => taken, so one owner cannot hold two seats on the same job
    mapping(uint256 => mapping(address => bool)) public holdsSeat;

    event Posted(uint256 indexed jobId, address indexed poster, bytes32 seal, uint256 price, uint64 endsAt);
    event SeatTaken(uint256 indexed jobId, Role role, address indexed agent, address indexed owner, uint256 deposit);
    event SeatReleased(uint256 indexed jobId, Role role, address indexed agent, string why);
    event Approved(uint256 indexed jobId, Role role, address indexed agent, bytes32 commitHash);
    event Settled(uint256 indexed jobId, bytes32 commitHash, uint256 paid);
    event Refunded(uint256 indexed jobId, uint256 amount, string why);

    error NotPoster();
    error NotValidator();
    error WrongState();
    error SeatFilled();
    error SeatEmpty();
    error OwnerAlreadySeated();
    error WrongDeposit();
    error NotTheSeat();
    error CommitMismatch();
    error PolicyNotMet();
    error TooLate();
    error TooEarly();

    constructor(address validator_) {
        require(validator_ != address(0), "bad validator");
        validator = validator_;
    }

    /// @notice Post a job with the money attached. The idea itself stays sealed until it opens.
    function post(bytes32 seal, uint64 endsAt, uint8 reviewers) external payable returns (uint256 jobId) {
        if (msg.value == 0) revert WrongDeposit();
        if (endsAt <= block.timestamp) revert TooLate();
        jobId = nextJobId++;
        jobs[jobId] = Job({
            poster: msg.sender,
            price: msg.value,
            seal: seal,
            endsAt: endsAt,
            state: State.Open,
            commit: bytes32(0),
            reviewers: reviewers == 0 ? 1 : reviewers
        });
        emit Posted(jobId, msg.sender, seal, msg.value, endsAt);
    }

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

    /// @notice Take a seat, first come first served, one owner to a job.
    /// @param owner the human or organisation behind the agent. Kept so a pod cannot be packed.
    function takeSeat(uint256 jobId, Role role, address owner) external payable {
        Job storage job = jobs[jobId];
        if (job.state != State.Open && job.state != State.Working) revert WrongState();
        if (block.timestamp >= job.endsAt) revert TooLate();
        if (holdsSeat[jobId][owner]) revert OwnerAlreadySeated();
        if (msg.value != seatDeposit(jobId, role)) revert WrongDeposit();

        Seat[] storage row = seats[jobId][uint8(role)];
        uint256 capacity = role == Role.Reviewer ? job.reviewers : 1;
        if (row.length >= capacity) revert SeatFilled();

        row.push(Seat({ agent: msg.sender, owner: owner, deposit: msg.value, approved: false }));
        holdsSeat[jobId][owner] = true;
        job.state = State.Working;
        emit SeatTaken(jobId, role, msg.sender, owner, msg.value);
    }

    /// @notice Approve the work, as the seat you hold, over one exact commit.
    /// @dev The first approval fixes the commit. A later push means a different commit, and every
    ///      earlier approval stops counting, which is the rule human teams keep forgetting.
    function approve(uint256 jobId, Role role, bytes32 commitHash) external {
        Job storage job = jobs[jobId];
        if (job.state != State.Working) revert WrongState();
        if (block.timestamp >= job.endsAt) revert TooLate();
        if (commitHash == bytes32(0)) revert CommitMismatch();

        if (job.commit == bytes32(0)) {
            job.commit = commitHash;
        } else if (job.commit != commitHash) {
            // the work moved on: start the approvals again
            _clearApprovals(jobId);
            job.commit = commitHash;
        }

        Seat storage seat = _seatOf(jobId, role, msg.sender);
        seat.approved = true;
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

    /// @notice The validator reports an independent re-run of the checks, and the money moves.
    /// @dev A failing verdict refunds rather than paying. The contract never decides quality itself.
    function settle(uint256 jobId, bytes32 commitHash, bool passed) external {
        if (msg.sender != validator) revert NotValidator();
        Job storage job = jobs[jobId];
        if (job.state != State.Working) revert WrongState();
        if (block.timestamp >= job.endsAt) revert TooLate();

        if (!passed) {
            job.state = State.Refunded;
            _returnDeposits(jobId);
            (bool ok, ) = job.poster.call{ value: job.price }("");
            require(ok, "refund failed");
            emit Refunded(jobId, job.price, "the checks did not pass");
            return;
        }

        if (!policyMet(jobId, commitHash)) revert PolicyNotMet();
        job.state = State.Settled;

        uint256 paid;
        for (uint8 r; r < 5; r++) {
            Seat[] storage row = seats[jobId][r];
            // seatPay already divides the reviewer share by the number of reviewer seats
            uint256 pay = seatPay(jobId, Role(r));
            for (uint256 i; i < row.length; i++) {
                uint256 amount = pay + row[i].deposit;
                paid += pay;
                (bool ok, ) = row[i].agent.call{ value: amount }("");
                require(ok, "pay failed");
            }
        }
        emit Settled(jobId, commitHash, paid);
    }

    /// @notice After the deadline, the poster takes the money back. Deposits go home too.
    function reclaim(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (msg.sender != job.poster) revert NotPoster();
        if (block.timestamp < job.endsAt) revert TooEarly();
        if (job.state == State.Settled || job.state == State.Refunded) revert WrongState();

        job.state = State.Refunded;
        _returnDeposits(jobId);
        (bool ok, ) = job.poster.call{ value: job.price }("");
        require(ok, "refund failed");
        emit Refunded(jobId, job.price, "the window closed");
    }

    function seatAt(uint256 jobId, Role role, uint256 index) external view returns (Seat memory) {
        return seats[jobId][uint8(role)][index];
    }

    function seatCount(uint256 jobId, Role role) external view returns (uint256) {
        return seats[jobId][uint8(role)].length;
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

    function _returnDeposits(uint256 jobId) internal {
        for (uint8 r; r < 5; r++) {
            Seat[] storage row = seats[jobId][r];
            for (uint256 i; i < row.length; i++) {
                uint256 deposit = row[i].deposit;
                if (deposit == 0) continue;
                row[i].deposit = 0;
                (bool ok, ) = row[i].agent.call{ value: deposit }("");
                require(ok, "deposit return failed");
            }
        }
    }
}
