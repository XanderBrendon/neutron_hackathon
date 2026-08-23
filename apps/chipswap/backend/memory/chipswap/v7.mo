// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
//
// V7 stops storing a crawl. The walk out across peers' directories moved to the
// browser, where it runs on the machine that asked and reaches this canister
// only as its result: a batch of addresses handed over when it finishes or is
// stopped.
//
// What V6 kept was `visited`, `cursors` and two counters describing a walk that
// is meaningful for about ninety seconds. It survived upgrades and it survived
// the tile closing, and every migration since has had to carry it. Managed
// memory is for what outlives a moment, and a crawl is a moment.
//
// Nothing is lost by dropping it. Every designer a crawl found was written
// straight into `directory` as it went, and a walk half-finished cannot be
// resumed by a canister that no longer walks.
//
// Every other type is V6's, unchanged.
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
    // `retired` says the same thing about a designer who appears to have
    // uninstalled Chipswap, and `strikes` is the count of consecutive calls they
    // failed to answer that led to it. A reply of any kind resets the count: the
    // question is whether anyone is home, not whether they liked the question.
    public type DirectoryEntry = {
        canister : Principal;
        source : DirectorySource;
        first_seen_ns : Int;
        last_seen_ns : Int;
        ignored : Bool;
        retired : Bool;
        strikes : Nat;
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
        #completed : ChipRef;
        #declined : Text;
        #failed : Text;
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
        designs : Map.Map<Nat, Design>;
        holdings : Map.Map<Text, Chip>;
        directory : Map.Map<Principal, DirectoryEntry>;
        incoming : Map.Map<Text, IncomingTrade>;
        outgoing : Map.Map<Text, OutgoingTrade>;
        replay : Map.Map<Text, ReplayRecord>;
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
                retired = false;
                strikes = 0;
            },
        );
        directory;
    };

    public func init() : Mem {
        {
            var revision = 0;
            var next_request_seq = 1;
            var next_brush_id = 1;
            designs = Map.empty<Nat, Design>();
            holdings = Map.empty<Text, Chip>();
            directory = seedDirectory();
            incoming = Map.empty<Text, IncomingTrade>();
            outgoing = Map.empty<Text, OutgoingTrade>();
            replay = Map.empty<Text, ReplayRecord>();
            brushes = List.empty<CustomBrush>();
        };
    };
}
