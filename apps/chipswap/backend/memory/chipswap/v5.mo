// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
//
// V5 changes one thing, and it is a clean-install default rather than a shape:
// a fresh directory is no longer empty.
//
// An empty directory is a dead end. Every way into the graph starts from
// somebody already in it — a catalog is fetched from a designer you know, a
// crawl asks the designers you know for the ones they know, and a trade needs a
// design you can already see. A canister installed with nobody to ask can only
// wait for a stranger to propose a trade first. So one address ships with the
// app, and the graph is reachable from the moment it is installed.
//
// `#seed` is a fifth source because the other four would each be a false
// statement about how this entry got here. It is the only claim the directory
// makes that the owner did not cause, and saying so plainly is what lets them
// remove it. Nothing else about the entry is special: it is fetched from,
// crawled, served, ignored, retired and evicted on exactly the terms every
// other entry is.
//
// Every type below is V4's, unchanged apart from that variant, and the V4 ->
// V5 migration carries an installed directory across verbatim. A seed is what
// an install starts with, not something an upgrade adds.
import List "mo:core/List";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Set "mo:core/Set";

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

    // `ignored` is a standing instruction not to fetch this designer's catalog,
    // not to carry them onward to peers, and not to show what we last cached
    // from them. The entry survives so that a crawl finding them again does not
    // quietly reinstate them.
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
        last_catalog_ns : ?Int;
        design_count : Nat;
    };

    public type CachedDesign = {
        design_id : Nat;
        title : Text;
        art : Art;
        requirements : TradeRequirements;
        nsfw : Bool;
        design_revision : Nat;
        published_at_ns : Int;
    };

    public type CachedCatalog = {
        designer : Principal;
        fetched_at_ns : Int;
        designs : [CachedDesign];
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

    // A crawl in progress. There is no frontier here because there does not need
    // to be one: every designer a crawl discovers is written to `directory`
    // immediately, so the work still outstanding is exactly the eligible entries
    // this crawl has not visited. Deriving it costs a scan and buys the
    // guarantee that a queue and the table can never disagree — ignore a
    // designer halfway through and they leave the frontier by themselves.
    //
    // `cursors` holds the next page offset for a peer whose directory is longer
    // than one reply. A peer with no cursor has either not been started or been
    // drained, and `visited` says which.
    public type Crawl = {
        started_at_ns : Int;
        var queried : Nat;
        var discovered : Nat;
        visited : Set.Set<Principal>;
        cursors : Map.Map<Principal, Nat>;
    };

    public type Mem = {
        var revision : Nat;
        var next_request_seq : Nat;
        var next_brush_id : Nat;
        var crawl : ?Crawl;
        designs : Map.Map<Nat, Design>;
        holdings : Map.Map<Text, Chip>;
        directory : Map.Map<Principal, DirectoryEntry>;
        catalog_cache : Map.Map<Principal, CachedCatalog>;
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
    // because they are not guesses: this designer has not been seen, and the
    // crawl and the catalog refresh both read those fields to decide who is
    // overdue. Zero puts the seed at the front of that queue, which is where a
    // designer nobody has ever contacted belongs.
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
                last_catalog_ns = null;
                design_count = 0;
            },
        );
        directory;
    };

    public func init() : Mem {
        {
            var revision = 0;
            var next_request_seq = 1;
            var next_brush_id = 1;
            var crawl = null;
            designs = Map.empty<Nat, Design>();
            holdings = Map.empty<Text, Chip>();
            directory = seedDirectory();
            catalog_cache = Map.empty<Principal, CachedCatalog>();
            incoming = Map.empty<Text, IncomingTrade>();
            outgoing = Map.empty<Text, OutgoingTrade>();
            replay = Map.empty<Text, ReplayRecord>();
            brushes = List.empty<CustomBrush>();
        };
    };
}
