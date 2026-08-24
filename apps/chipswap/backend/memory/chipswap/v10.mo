// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
//
// V10 lets the owner turn away one chip rather than a whole designer.
//
// Ignoring a designer was the only judgement this table could hold, and it is a
// blunt one: a reader tired of two chips had to choose between keeping the
// designer's whole catalogue on screen and losing all of it. `ignored_designs`
// is the smaller gesture — the design ids of that designer's chips the Market
// should stop showing, and nothing more.
//
// It lives on the directory entry rather than in a root of its own because
// every rule it needs then falls out of the shape instead of out of code that
// has to remember to run. Removing a designer removes the entry, and their
// ignored chips go with it — which covers `Directory.evictOne` as well as the
// route the owner presses. Ignoring a designer only flips the flag beside it,
// so un-ignoring them restores the per-chip decisions they had made. And the
// whole feature is bounded by the directory it hangs off: `MAX_DIRECTORY`
// entries, each holding at most the ten designs a catalogue can carry.
//
// It is a display preference and nothing else. It does not stop that designer's
// catalogue being fetched — the other chips are still wanted — it does not stop
// the design being traded for, and no peer ever reads it.
//
import List "mo:core/List";
import Map "mo:core/Map";
import Principal "mo:core/Principal";

module {
    // Palette-indexed chip art. `shape_id` travels with the art so a future chip
    // shape is a new accepted id rather than a memory migration.
    public type Art = {
        shape_id : Text;
        palette : [Nat32]; // 0x00RRGGBB
        pixels : Blob; // one palette index per mask cell
    };

    public type DesignState = { #draft; #published };

    // What a designer will accept in exchange. `#disallowed` and `#required`
    // both judge the offered chip's own tag, which is the offering canister's
    // claim about its art: a chip carries the tag its design had when it was
    // minted, the same way it carries the title.
    public type NsfwRule = { #disallowed; #required };

    // Every field is optional in the sense that matters: `approval = false` with
    // the three nulls is a design anyone may swap for, unconditionally.
    //
    // `approval` is the one requirement that does not refuse an offer. It holds
    // a qualifying offer in escrow for the designer to answer.
    public type TradeRequirements = {
        approval : Bool;
        /** Distinct colours the offered art must actually paint, at least. */
        min_colors : ?Nat;
        /** Percent of the offered chip one colour may cover, at most. */
        max_coverage : ?Nat;
        nsfw : ?NsfwRule;
    };

    // One of the ten design slots. A draft occupies a slot until it is deleted
    // or published; publishing consumes the slot permanently and freezes the
    // title and art. `requirements` and `nsfw` stay mutable because they are
    // trading policy and a label, not artwork.
    public type Design = {
        design_id : Nat;
        title : Text;
        art : Art;
        state : DesignState;
        requirements : TradeRequirements;
        nsfw : Bool;
        revision : Nat;
        created_at_ns : Int;
        published_at_ns : ?Int;
        next_serial : Nat;
    };

    // A minted instance. `designer` doubles as the directory pointer that lets a
    // holder find the designer's other chips.
    public type ChipRef = {
        designer : Principal;
        design_id : Nat;
        serial : Nat;
    };

    // `#escrowed` is an offer that left for a peer; `#uncertain` is an offer
    // whose outcome was never confirmed. Neither is spendable.
    public type ChipState = {
        #held;
        #escrowed : { request_id : Blob; peer : Principal; since_ns : Int };
        #uncertain : { request_id : Blob; peer : Principal; since_ns : Int };
    };

    // `nsfw` is fixed at minting rather than read from the design, so a chip
    // already in someone's collection keeps the label it was handed over with.
    public type Chip = {
        ref : ChipRef;
        title : Text;
        art : Art;
        nsfw : Bool;
        design_revision : Nat;
        minted_at_ns : Int;
        acquired_at_ns : Int;
        state : ChipState;
    };

    // How this designer got here. Four of the five are the owner's doing,
    // directly or at one remove. `#seed` is the one that is not: it is the
    // address the app was installed with, and it says so rather than borrowing
    // a story from one of the others.
    public type DirectorySource = {
        #manual;
        #contacts;
        #trade;
        #crawl;
        #seed;
    };

    // `ignored` is a standing instruction not to ask this designer for a
    // catalog and not to carry them onward to peers. The entry survives so that
    // a crawl finding them again does not quietly reinstate them.
    //
    // It is the only judgement stored about a designer. Whether their canister
    // still answers is not stored at all: it is a fact about right now, the
    // browser learns it every time it reads a catalog, and a copy of it kept
    // here would be a guess going stale beside the real thing.
    // `ignored_designs` holds the design ids of this designer's chips the owner
    // has turned away, ascending and without repeats. A set has no order of its
    // own, so giving it one keeps two equal lists from comparing as different.
    //
    // It is the narrower sibling of `ignored`: that one withholds the designer,
    // this one withholds a chip. They are independent, and deliberately so —
    // ignoring the designer must leave these decisions intact, because
    // un-ignoring them should restore what the owner chose rather than a blank
    // list they have to choose all over again.
    public type DirectoryEntry = {
        canister : Principal;
        source : DirectorySource;
        first_seen_ns : Int;
        last_seen_ns : Int;
        ignored : Bool;
        ignored_designs : [Nat];
    };

    // `nsfw` is the tag the minted chip left with. A designer may retag their
    // design afterwards, and a retried delivery must still hand over the chip
    // that was minted rather than a relabelled one.
    public type IncomingState = {
        #pending;
        #accepted : { serial : Nat; nsfw : Bool };
        #declined;
    };

    // A manual-mode proposal received from a peer. The offered chip stays here,
    // out of `holdings`, until the owner accepts or declines it.
    public type IncomingTrade = {
        request_id : Blob;
        peer : Principal;
        want_design_id : Nat;
        offered : Chip;
        state : IncomingState;
        received_at_ns : Int;
        updated_at_ns : Int;
    };

    public type OutgoingState = {
        #sending;
        #pending_designer;
        #uncertain;
    };

    // `offered_key` is null when the offer was minted from one of our own
    // designs, because minting costs us nothing and escrows nothing.
    public type OutgoingTrade = {
        request_id : Blob;
        peer : Principal;
        want_design_id : Nat;
        offered_key : ?Text;
        offered_ref : ChipRef;
        offered_title : Text;
        state : OutgoingState;
        created_at_ns : Int;
        updated_at_ns : Int;
    };

    public type HistoryDirection = { #outgoing; #incoming };

    // One side's chip, named rather than copied.
    public type HistoryChip = { title : Text; ref : ChipRef };

    // `ours` and `theirs` are sides of the swap, not directions of travel, and
    // the outcome says whether the chips actually moved. Naming them for travel
    // would empty both fields on exactly the rows this record exists for: an
    // offer we declined moved nothing, and the row still has to name the chip
    // that was turned down.
    public type HistoryOutcome = {
        #traded;
        #declined_by_peer : Text;
        #declined_by_owner;
        #failed : Text;
        #unresolved;
    };

    // `escrow_key` is `OutgoingTrade.offered_key` carried across: null when the
    // offer was minted from one of our own designs and so cost us nothing.
    // Resolving an `#unresolved` entry later has to release or consume the chip
    // that is still escrowed, and this is how it finds it.
    public type HistoryEntry = {
        entry_id : Nat;
        direction : HistoryDirection;
        peer : Principal;
        request_id : Blob;
        want_design_id : Nat;
        ours : ?HistoryChip;
        theirs : ?HistoryChip;
        escrow_key : ?Text;
        outcome : HistoryOutcome;
        started_at_ns : Int;
        settled_at_ns : Int;
    };

    public type ReplayOutcome = {
        #minted : { design_id : Nat; serial : Nat; nsfw : Bool };
        #pending;
        #declined : Text;
    };

    // Inbound idempotency: a repeated (peer, request id) replays this outcome
    // instead of minting or admitting a second time.
    public type ReplayRecord = {
        request_id : Blob;
        peer : Principal;
        outcome : ReplayOutcome;
        recorded_at_ns : Int;
    };

    public type CustomBrush = {
        id : Nat;
        name : Text;
        width : Nat;
        height : Nat;
        anchor_x : Nat;
        anchor_y : Nat;
        cells : Blob; // width * height flags, row-major
    };

    public type Mem = {
        var revision : Nat;
        var next_request_seq : Nat;
        var next_brush_id : Nat;
        var next_history_id : Nat;
        designs : Map.Map<Nat, Design>;
        holdings : Map.Map<Text, Chip>;
        directory : Map.Map<Principal, DirectoryEntry>;
        incoming : Map.Map<Text, IncomingTrade>;
        outgoing : Map.Map<Text, OutgoingTrade>;
        replay : Map.Map<Text, ReplayRecord>;
        history : Map.Map<Nat, HistoryEntry>;
        brushes : List.List<CustomBrush>;
    };

    // A design nobody has to satisfy: the default a new draft opens with.
    public func openRequirements() : TradeRequirements {
        {
            approval = false;
            min_colors = null;
            max_coverage = null;
            nsfw = null;
        };
    };

    // The designer a fresh install starts knowing. Publishes chips, and is the
    // best-connected directory to crawl outward from, so one address is enough
    // to reach the rest of the graph.
    public func seedDesigner() : Principal {
        Principal.fromText("3wvx3-yaaaa-aaaay-aacuq-cai");
    };

    // The one entry a clean install begins with. Both timestamps are zero
    // because they are not guesses: this designer has genuinely not been seen.
    // Writing a plausible-looking time instead would make the table claim a
    // contact that never happened, and `last_seen_ns` is what eviction reads.
    func seedDirectory() : Map.Map<Principal, DirectoryEntry> {
        let directory = Map.empty<Principal, DirectoryEntry>();
        let canister = seedDesigner();
        Map.add(
            directory,
            Principal.compare,
            canister,
            {
                canister;
                source = #seed;
                first_seen_ns = 0;
                last_seen_ns = 0;
                ignored = false;
                ignored_designs = [];
            },
        );
        directory;
    };

    public func init() : Mem {
        {
            var revision = 0;
            var next_request_seq = 1;
            var next_brush_id = 1;
            var next_history_id = 1;
            designs = Map.empty<Nat, Design>();
            holdings = Map.empty<Text, Chip>();
            directory = seedDirectory();
            incoming = Map.empty<Text, IncomingTrade>();
            outgoing = Map.empty<Text, OutgoingTrade>();
            replay = Map.empty<Text, ReplayRecord>();
            history = Map.empty<Nat, HistoryEntry>();
            brushes = List.empty<CustomBrush>();
        };
    };
}
