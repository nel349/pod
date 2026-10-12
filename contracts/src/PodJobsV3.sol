// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PodJobsV3: the poster has the last word.
/// @notice Everything PodJobsV2 does up to the moment a pod's work is graded, and then this: the
///         validator reports what the independent re-run of the checks found, and no money moves.
///         The poster, who by then can open the work, accepts or refuses with their own transaction.
///         If they say nothing in the time they have, anybody may settle the job as the checks found.
///
/// Accepting pays the pod, whatever the checks found: a proof of concept can be worth paying for.
/// Refusing work whose checks failed returns everything. Refusing work whose checks passed leaves the
/// pod a quarter of what it would have been paid, because it delivered what both sides agreed to test.
///
/// No seat can stop a delivery. The builder puts its own work forward, and the other seats say
/// whether they stand behind it. When every seat that is taken does, it is graded at once: nobody
/// waits for a seat nobody took. When one that is taken says nothing, it is graded all the same once
/// the time for reviewing has run out, a quarter of the job's window, with whoever stands behind it
/// by then: a seat that says nothing holds nothing back, and a poster's own wallet in a seat, or in
/// every seat but the builder's, cannot keep honest work from reaching its verdict. Pay, risk and
/// record follow who stood behind the work: the builder and the seats that said yes are paid when the
/// pod is paid, lose their deposits when a check they could see fails, and have the job counted for
/// them. A seat that said nothing gets its deposit home and nothing else.
///
/// The contract also keeps count, for every poster and every agent, of how their jobs ended, so that
/// an agent can know a poster who refuses by habit, and a poster an agent whose work is refused,
/// without taking anybody's word for it.
///
/// What this contract does NOT decide: whether the work is any good. The poster does, and the checks
/// do when the poster is silent. The validator can move no job's money.
///
/// It replaces PodJobsV2 for new jobs only. Older jobs stay on their contracts, and numbering
/// continues from them, because titles are numbered by the job's number alone. Everything PodJobsV2
/// lets a reader ask is asked the same way here.
contract PodJobsV3 {
    enum Role { Lead, Builder, Reviewer, QA, Security }
    /// @dev new states go last, so the older contracts' numbers mean the same here. Delivered: the
    ///      validator has reported, and the job waits for its poster's answer
    enum State { Open, Working, Settled, Refunded, Preparing, Delivered }
    /// @dev what the validator found. None is only ever the empty record
    enum Verdict { None, Passed, HiddenFailed, VisibleFailed }
    /// @dev how a delivered job ended: what its poster said, or that they said nothing in time
    enum Answer { None, Accepted, Refused, Unanswered }

    /// @dev the old contract's fields first, in its order; new ones after
    struct Job {
        address poster;
        uint256 price;      // what the pod is paid, without the money for writing the checks
        bytes32 seal;       // the seal of the whole spec, set when the poster approves the checks
        uint64 endsAt;      // set when the poster approves: the window starts then, not at payment
        State state;
        bytes32 commit;     // the commit the builder put forward, which the seats' approvals are bound to
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

    /// @notice how a poster's jobs have ended. Refusing work whose checks passed is the count an
    ///         agent looks at before taking a seat
    struct PosterRecord {
        uint32 posted;
        uint32 accepted;
        uint32 refusedPassed;   // refused although the checks passed: the pod kept a quarter
        uint32 refusedFailed;   // refused after the checks failed: everything went back
        uint32 unanswered;      // said nothing in time, so the checks decided
    }

    /// @notice how the jobs an agent stood behind have ended: the ones it put forward as their
    ///         builder, and the ones it said yes to from another seat. A job is counted once for an
    ///         agent, however many of its seats that agent held, and not at all for an agent that
    ///         held a seat and did not stand behind the work
    struct AgentRecord {
        uint32 accepted;        // the poster accepted the work
        uint32 paidUnanswered;  // the poster said nothing and the checks passed
        uint32 refusedPassed;   // the poster refused although the checks passed
        uint32 failed;          // the checks failed, and the poster refused or said nothing
        uint32 undelivered;     // as the builder: the window closed with no work of its ever reaching grading
    }

    struct Seat {
        address agent;      // the wallet that signs for this seat
        address owner;      // who owns that agent, for the one-owner-one-seat rule
        uint256 deposit;
        bool approved;      // stands behind the commit put forward: the builder by putting it forward, any other seat by saying yes
    }

    /// @notice shares per role, in percent, in the order of the Role enum. Adds to 100.
    uint8[5] public shares = [20, 40, 15, 15, 10];
    /// @notice a seat's deposit, as a percentage of what that seat is paid
    uint8 public constant DEPOSIT_PERCENT = 10;
    /// @notice the most reviewer seats a job can have, so paying every seat always fits in one block
    uint8 public constant MAX_REVIEWERS = 5;
    /// @notice writings of the checks paid for with the job; each one after is paid for on its own
    uint8 public constant WRITINGS_INCLUDED = 3;
    /// @notice how long a writing can stay reserved before its poster may release it
    uint64 public constant RESERVATION_TIMEOUT = 1 days;
    /// @notice what a pod keeps, in percent of each seat's pay, when its poster refuses work whose
    ///         checks passed
    uint8 public constant REFUSAL_SHARE_PERCENT = 25;
    /// @notice the least and the most a poster can be given to answer, and the most gas a payment can
    ///         be sent with: settings fixed for good at deployment, where a slip of a unit would
    ///         otherwise hold a pod's pay for years, or make ten payments too heavy for one call
    uint64 public constant LEAST_ANSWER_TIME = 1 hours;
    uint64 public constant MOST_ANSWER_TIME = 30 days;
    uint256 public constant MOST_PAYOUT_GAS = 500_000;
    /// @notice how long the other seats have to say whether they stand behind what a builder put
    ///         forward, in percent of the job's window: half an hour of a two-hour job, six hours of
    ///         a day's. A real review of a real job takes hours, and a short job cannot spare them,
    ///         so it grows with the job. It is only ever waited out when a seat that is taken says
    ///         nothing, and it leaves a builder three quarters of the window whatever the others do
    uint8 public constant REVIEW_SHARE_PERCENT = 25;
    /// @notice what the writer's signature over an approval is for, so it can mean nothing else
    bytes32 public constant CHECKS_WRITTEN = keccak256("pod.checks-written.v1");
    /// @dev how many roles there are, in the order of the Role enum
    uint8 internal constant ROLE_COUNT = 5;
    /// @dev half the order of the curve signatures are made on: a signature's s above it is the
    ///      mirror of one below, the same signature in another form
    uint256 internal constant HALF_THE_CURVE =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// @notice the only address whose report of the checks this contract will accept, and where
    ///         writing money goes. It can move no job's money
    address public immutable validator;
    /// @notice the address that writes the checks: it reserves, keeps and releases writing money, and
    ///         signs the checks it wrote. It can move no other money.
    address public immutable writer;
    /// @notice what one writing of a job's checks costs, fixed at deployment
    uint256 public immutable writingPrice;
    /// @notice gas sent with every payment. A payee that needs more, or refuses, withdraws instead.
    uint256 public immutable payoutGas;
    /// @notice how long a poster has to accept or refuse once the validator has reported, in seconds
    uint64 public immutable answerTime;

    uint256 public nextJobId;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => Writing) public writings;
    mapping(uint256 => Report) public reports;
    /// @notice until when a delivered job's poster may refuse, after which anybody may settle it as
    ///         the checks found. Zero for a job not delivered
    mapping(uint256 => uint64) public answerBy;
    /// @notice how each delivered job ended, so anybody can ask of one job without reading events
    mapping(uint256 => Answer) public answers;
    /// @notice until when the other seats may say whether they stand behind the commit put forward,
    ///         after which it is graded whoever does. Zero while nothing is put forward
    mapping(uint256 => uint64) public reviewBy;
    /// @notice the commit the validator last let go of, until the builder puts work forward again. It
    ///         has had its review, so put forward again as it is, it is graded again at once
    mapping(uint256 => bytes32) public released;
    /// @notice whether work of this job ever reached grading. A job that closes after that is not
    ///         counted against its builder as undelivered, whatever became of the grading
    mapping(uint256 => bool) public wasLocked;
    mapping(address => PosterRecord) public posters;
    mapping(address => AgentRecord) public agents;
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
    event PutForward(uint256 indexed jobId, address indexed builder, bytes32 commitHash, uint64 reviewBy);
    event Approved(uint256 indexed jobId, Role role, address indexed agent, bytes32 commitHash);
    event LockReleased(uint256 indexed jobId, bytes32 commitHash);
    event Delivered(uint256 indexed jobId, bytes32 commitHash, Verdict verdict, bytes32 receiptHash, uint64 answerBy);
    event Accepted(uint256 indexed jobId, address indexed poster);
    event Refused(uint256 indexed jobId, address indexed poster, uint256 keptByThePod);
    event SettledUnanswered(uint256 indexed jobId, Verdict verdict);
    event Settled(uint256 indexed jobId, bytes32 commitHash, uint256 paid, bytes32 receiptHash);
    event DepositForfeited(uint256 indexed jobId, Role role, address indexed agent, uint256 amount);
    event Refunded(uint256 indexed jobId, uint256 amount, string why);
    event PaymentHeld(address indexed payee, uint256 amount);
    event Withdrawn(address indexed payee, address indexed to, uint256 amount);

    error NotPoster();
    error PosterTakesNoSeat();
    error NotValidator();
    error NotWriter();
    error WrongState();
    error WrongAmount();
    error TooManyReviewers();
    error NoWindow();
    error NoSuchJob();
    error BuildersDoNotApprove();
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
    error NoVerdict();
    error TooLate();
    error TooEarly();
    error NothingOwed();
    error PaymentFailed();

    constructor(address validator_, address writer_, uint256 firstJobId, uint256 writingPrice_, uint256 payoutGas_, uint64 answerTime_) {
        require(validator_ != address(0) && writer_ != address(0), "bad address");
        require(firstJobId != 0, "jobs are numbered from 1");
        require(writingPrice_ != 0 && payoutGas_ != 0, "bad setting");
        require(payoutGas_ <= MOST_PAYOUT_GAS, "too much gas for a payment");
        require(answerTime_ >= LEAST_ANSWER_TIME && answerTime_ <= MOST_ANSWER_TIME, "a poster answers within an hour to thirty days");
        validator = validator_;
        writer = writer_;
        nextJobId = firstJobId;
        writingPrice = writingPrice_;
        payoutGas = payoutGas_;
        answerTime = answerTime_;
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
        posters[msg.sender].posted += 1;
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

    /// @notice How long the other seats have to say whether they stand behind work put forward on
    ///         this job: a share of its window, so always shorter than it.
    function reviewTimeOf(uint256 jobId) public view returns (uint64) {
        return uint64((uint256(jobs[jobId].window) * REVIEW_SHARE_PERCENT) / 100);
    }

    /// @notice What a seat must put down to hold it.
    function seatDeposit(uint256 jobId, Role role) public view returns (uint256) {
        return (seatPay(jobId, role) * DEPOSIT_PERCENT) / 100;
    }

    /// @notice Take a seat, first come first served, one owner to a job. Never on a job still preparing,
    ///         and never while it is locked: the work is being graded, and nobody who was not there
    ///         to review it can stand behind it. Never its own poster's, as agent or as owner: a seat
    ///         reads the pod's work before it is paid for, and whoever has the last word on that work
    ///         does not also sit in judgement of it, or earn a record from a job they answer themselves.
    /// @dev This turns away the poster's own address, not a second one of theirs: nothing on a chain
    ///      can. What makes taking the work and refusing it cost something is REFUSAL_SHARE_PERCENT.
    /// @param owner the human or organisation behind the agent. Kept so a pod cannot be packed.
    function takeSeat(uint256 jobId, Role role, address owner) external payable {
        Job storage job = jobs[jobId];
        if (job.state != State.Open && job.state != State.Working) revert WrongState();
        if (block.timestamp >= job.endsAt) revert TooLate();
        if (locked(jobId)) revert Locked();
        if (msg.sender == job.poster || owner == job.poster) revert PosterTakesNoSeat();
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

    /// @notice The builder puts its work forward, as one exact commit, to be reviewed and graded.
    /// @dev Only the builder names what is graded: it is the builder's work, and a seat that could
    ///      name something else could have junk graded in its place. Putting forward stands behind
    ///      it, as an approval does for another seat. A new commit put forward while the review
    ///      runs replaces the last, clears what was said about it and starts the time again, which
    ///      is how a refusal is answered. Once locked, nothing else is taken until the validator
    ///      reports, lets go, or the window closes. And it is locked the moment every other seat
    ///      taken stands behind it, at once if none is, so a builder puts forward only what it is
    ///      ready to have graded.
    function putForward(uint256 jobId, bytes32 commitHash) external {
        Job storage job = jobs[jobId];
        if (job.state != State.Working) revert WrongState();
        if (block.timestamp >= job.endsAt) revert TooLate();
        if (commitHash == bytes32(0) || commitHash == job.commit) revert CommitMismatch();
        Seat storage builder = _seatOf(jobId, Role.Builder, msg.sender);
        if (locked(jobId)) revert Locked();

        // The commit the validator let go of, put forward again as it is: it has had its review, and
        // whoever stood behind it still does, so it goes back to grading at once. Were it given a
        // whole review again, a release late in the window would hand a seat that says nothing the
        // very thing this contract takes from it: the power to run the window out.
        uint64 until = uint64(block.timestamp);
        if (commitHash != released[jobId]) {
            _clearApprovals(jobId);
            until += reviewTimeOf(jobId);
        }
        released[jobId] = bytes32(0);
        job.commit = commitHash;
        builder.approved = true;
        reviewBy[jobId] = until;
        // a builder nobody sits beside has everybody's word already
        if (!wasLocked[jobId] && policyMet(jobId, commitHash)) wasLocked[jobId] = true;
        emit PutForward(jobId, msg.sender, commitHash, until);
    }

    /// @notice Say you stand behind the work the builder put forward, as the seat you hold, over
    ///         that exact commit, while its review runs.
    /// @dev An approval decides nothing about whether the work is graded, only who is paid for it,
    ///      who loses a deposit if a check the pod could see fails, and whose record it goes on.
    ///      It is taken only until the time for reviewing runs out, so that nobody waits to see
    ///      which way the verdict went before signing on.
    function approve(uint256 jobId, Role role, bytes32 commitHash) external {
        // the builder stands behind its work by putting it forward, and by nothing else
        if (role == Role.Builder) revert BuildersDoNotApprove();
        Job storage job = jobs[jobId];
        if (job.state != State.Working) revert WrongState();
        if (commitHash == bytes32(0) || commitHash != job.commit) revert CommitMismatch();
        if (block.timestamp >= job.endsAt || block.timestamp >= reviewBy[jobId]) revert TooLate();

        // every seat of that role the agent holds: an agent in two reviewer seats says yes from both
        Seat[] storage row = seats[jobId][uint8(role)];
        bool holdsOne;
        for (uint256 i; i < row.length; i++) {
            if (row[i].agent != msg.sender) continue;
            row[i].approved = true;
            holdsOne = true;
        }
        if (!holdsOne) revert NotTheSeat();
        if (!wasLocked[jobId] && policyMet(jobId, commitHash)) wasLocked[jobId] = true;
        emit Approved(jobId, role, msg.sender, commitHash);
    }

    /// @notice Whether every seat that is taken stands behind the commit given: its builder, who put
    ///         it forward, and every other seat somebody holds. Work so agreed on is graded at once,
    ///         without waiting out the time for reviewing. A seat nobody took has no say and is not
    ///         waited for: a builder alone has everybody's agreement.
    function policyMet(uint256 jobId, bytes32 commitHash) public view returns (bool) {
        Job storage job = jobs[jobId];
        if (job.commit == bytes32(0) || job.commit != commitHash) return false;
        for (uint8 r; r < ROLE_COUNT; r++) {
            Seat[] storage row = seats[jobId][r];
            // every one of them, so that no seat is locked out of standing behind work it was still reading
            for (uint256 i; i < row.length; i++) if (!row[i].approved) return false;
        }
        return true;
    }

    /// @notice Whether the job is locked on the commit put forward, waiting for its verdict: every
    ///         seat taken stands behind it, or the time for reviewing it has run out.
    function locked(uint256 jobId) public view returns (bool) {
        bytes32 commit = jobs[jobId].commit;
        return commit != bytes32(0) && (block.timestamp >= reviewBy[jobId] || policyMet(jobId, commit));
    }

    /// @notice The validator lets go of a locked job it could not grade, or whose runs disagreed, so
    ///         that nothing is graded until the builder puts work forward again. What the seats said
    ///         of the commit let go of stands until then: put forward again as it is, it goes back to
    ///         grading at once, with the same seats behind it; a different commit starts afresh.
    function releaseLock(uint256 jobId) external {
        if (msg.sender != validator) revert NotValidator();
        Job storage job = jobs[jobId];
        if (job.state != State.Working) revert WrongState();
        // after the window nothing can be graded, so there is nothing to let go of: work put forward
        // too late to lock inside it never reached grading, and a release must not say it did
        if (block.timestamp >= job.endsAt) revert TooLate();
        if (!locked(jobId)) revert NotLocked();
        bytes32 was = job.commit;
        // it reached grading, which is all a builder can do: what became of the grading is not its doing
        wasLocked[jobId] = true;
        released[jobId] = was;
        job.commit = bytes32(0);
        reviewBy[jobId] = 0;
        emit LockReleased(jobId, was);
    }

    /// @notice The validator reports an independent re-run of the checks on the job's current commit.
    ///         No money moves: the job is delivered, and its poster's time to answer starts.
    function report(uint256 jobId, bytes32 commitHash, Verdict verdict, bytes32 receiptHash) external {
        if (msg.sender != validator) revert NotValidator();
        Job storage job = jobs[jobId];
        if (job.state != State.Working) revert WrongState();
        if (block.timestamp >= job.endsAt) revert TooLate();
        if (verdict == Verdict.None) revert NoVerdict();
        if (commitHash == bytes32(0) || commitHash != job.commit) revert CommitMismatch();
        if (!locked(jobId)) revert NotLocked();

        reports[jobId] = Report({ verdict: verdict, receiptHash: receiptHash });
        job.state = State.Delivered;
        uint64 until = uint64(block.timestamp) + answerTime;
        answerBy[jobId] = until;
        emit Delivered(jobId, commitHash, verdict, receiptHash, until);
    }

    /// @notice The poster accepts the delivered work, and the builder and every seat that stood
    ///         behind it are paid, whatever the checks found.
    /// @dev Open for as long as the job is delivered: past the time to answer too, until somebody
    ///      settles it, since a late yes takes nothing from anybody that the checks would not.
    function accept(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (msg.sender != job.poster) revert NotPoster();
        if (job.state != State.Delivered) revert WrongState();
        posters[msg.sender].accepted += 1;
        answers[jobId] = Answer.Accepted;
        emit Accepted(jobId, msg.sender);
        _payThePod(jobId, Ending.Accepted);
    }

    /// @notice The poster refuses the delivered work, within their time to answer. If its checks
    ///         failed, everything goes back as it would have. If they passed, the builder and every
    ///         seat that stood behind it keep a quarter of their pay.
    function refuse(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (msg.sender != job.poster) revert NotPoster();
        if (job.state != State.Delivered) revert WrongState();
        if (block.timestamp >= answerBy[jobId]) revert TooLate();
        Verdict verdict = reports[jobId].verdict;
        answers[jobId] = Answer.Refused;
        if (verdict == Verdict.Passed) {
            posters[msg.sender].refusedPassed += 1;
            _refuseWhatPassed(jobId);
        } else {
            posters[msg.sender].refusedFailed += 1;
            emit Refused(jobId, msg.sender, 0);
            _refundAfterFailure(jobId, verdict == Verdict.VisibleFailed);
        }
    }

    /// @notice The poster said nothing in their time: anybody may settle the job as the checks found.
    ///         A pass pays the builder and every seat that stood behind the work. A failure refunds
    ///         the poster, and those same seats lose their deposits to the poster only when a check
    ///         the pod could see failed.
    function settleUnanswered(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.state != State.Delivered) revert WrongState();
        if (block.timestamp < answerBy[jobId]) revert TooEarly();
        Verdict verdict = reports[jobId].verdict;
        posters[job.poster].unanswered += 1;
        answers[jobId] = Answer.Unanswered;
        emit SettledUnanswered(jobId, verdict);
        if (verdict == Verdict.Passed) _payThePod(jobId, Ending.PaidUnanswered);
        else _refundAfterFailure(jobId, verdict == Verdict.VisibleFailed);
    }

    /// @notice After the window, anybody may close a job that was never delivered: the money goes back
    ///         to the poster and every deposit home, since nothing was judged. A delivered job is not
    ///         closed: it is answered by its poster, or settled as its checks found.
    function close(uint256 jobId) external {
        Job storage job = jobs[jobId];
        // a number never given out reads as an open job with no window: it is no job at all
        if (job.poster == address(0)) revert NoSuchJob();
        if (job.state != State.Open && job.state != State.Working) revert WrongState();
        if (block.timestamp < job.endsAt) revert TooEarly();
        job.state = State.Refunded;
        emit Refunded(jobId, job.price, "the window closed with nothing delivered");
        // work that reached grading inside the window was delivered, whether or not it was ever reported
        // on, and whether or not the validator let it go since: neither is the builder's doing
        bytes32 commit = job.commit;
        bool reachedGrading = wasLocked[jobId] || (commit != bytes32(0) && (reviewBy[jobId] < job.endsAt || policyMet(jobId, commit)));
        _returnDeposits(jobId, !reachedGrading);
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

    /// @dev how a job ended, for the count each seat's agent keeps
    enum Ending { Accepted, PaidUnanswered, RefusedPassed, Failed }

    /// @dev Count a job's ending for the agent in a seat that stood behind the work, once for the
    ///      job: an agent behind it from several seats is counted for the first of them, in the
    ///      order they are paid.
    function _count(uint256 jobId, uint8 role, uint256 index, Ending ending) internal {
        address agent = seats[jobId][role][index].agent;
        for (uint8 r; r <= role; r++) {
            Seat[] storage row = seats[jobId][r];
            uint256 before = r == role ? index : row.length;
            for (uint256 i; i < before; i++) if (row[i].agent == agent && row[i].approved) return;
        }
        AgentRecord storage record = agents[agent];
        if (ending == Ending.Accepted) record.accepted += 1;
        else if (ending == Ending.PaidUnanswered) record.paidUnanswered += 1;
        else if (ending == Ending.RefusedPassed) record.refusedPassed += 1;
        else record.failed += 1;
    }

    function _payThePod(uint256 jobId, Ending ending) internal {
        Job storage job = jobs[jobId];
        job.state = State.Settled;
        uint256 paid;
        for (uint8 r; r < ROLE_COUNT; r++) {
            Seat[] storage row = seats[jobId][r];
            // seatPay already divides the reviewer share by the number of reviewer seats
            uint256 pay = seatPay(jobId, Role(r));
            for (uint256 i; i < row.length; i++) {
                uint256 deposit = row[i].deposit;
                row[i].deposit = 0;
                // a seat that did not stand behind the work is paid nothing for it, and gets its deposit home
                if (!row[i].approved) {
                    _pay(row[i].agent, deposit);
                    continue;
                }
                paid += pay;
                _count(jobId, r, i, ending);
                _pay(row[i].agent, pay + deposit);
            }
        }
        emit Settled(jobId, job.commit, paid, reports[jobId].receiptHash);
        // what rounding leaves, and the share of every seat never taken or not behind the work
        _pay(job.poster, job.price - paid);
    }

    /// @dev The poster refused work whose checks passed: the builder and each seat that stood behind
    ///      it keep a quarter of their pay, every seat gets its deposit home, and the poster gets the
    ///      rest of the price.
    function _refuseWhatPassed(uint256 jobId) internal {
        Job storage job = jobs[jobId];
        job.state = State.Refunded;
        uint256 kept;
        for (uint8 r; r < ROLE_COUNT; r++) {
            Seat[] storage row = seats[jobId][r];
            uint256 share = (seatPay(jobId, Role(r)) * REFUSAL_SHARE_PERCENT) / 100;
            for (uint256 i; i < row.length; i++) {
                uint256 deposit = row[i].deposit;
                row[i].deposit = 0;
                if (!row[i].approved) {
                    _pay(row[i].agent, deposit);
                    continue;
                }
                kept += share;
                _count(jobId, r, i, Ending.RefusedPassed);
                _pay(row[i].agent, share + deposit);
            }
        }
        emit Refused(jobId, job.poster, kept);
        emit Refunded(jobId, job.price - kept, "refused, though its checks passed");
        _pay(job.poster, job.price - kept);
    }

    function _refundAfterFailure(uint256 jobId, bool isForfeit) internal {
        Job storage job = jobs[jobId];
        job.state = State.Refunded;
        uint256 forfeited;
        for (uint8 r; r < ROLE_COUNT; r++) {
            Seat[] storage row = seats[jobId][r];
            for (uint256 i; i < row.length; i++) {
                uint256 deposit = row[i].deposit;
                row[i].deposit = 0;
                // only who stood behind failed work answers for it: the builder who put it forward, and the seats that said yes
                if (!row[i].approved) {
                    _pay(row[i].agent, deposit);
                    continue;
                }
                _count(jobId, r, i, Ending.Failed);
                if (isForfeit) {
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

    /// @param isUndelivered whether the seats are being sent home from a job no work of which ever
    ///        reached grading, which its builder is counted for and nobody else: only a builder can
    ///        put work forward, and nothing any other seat does or leaves undone can keep it back
    function _returnDeposits(uint256 jobId, bool isUndelivered) internal {
        for (uint8 r; r < ROLE_COUNT; r++) {
            Seat[] storage row = seats[jobId][r];
            for (uint256 i; i < row.length; i++) {
                uint256 deposit = row[i].deposit;
                row[i].deposit = 0;
                if (isUndelivered && r == uint8(Role.Builder)) agents[row[i].agent].undelivered += 1;
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

    function _clearApprovals(uint256 jobId) internal {
        for (uint8 r; r < ROLE_COUNT; r++) {
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
        if (uint256(s) > HALF_THE_CURVE) return address(0);
        if (v != 27 && v != 28) return address(0);
        bytes32 signed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        return ecrecover(signed, v, r, s);
    }
}
