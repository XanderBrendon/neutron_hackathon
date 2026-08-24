import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import List "mo:core/List";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Shape "./Shape";

// The CSW1 peer reply wire.
//
// Handler *inputs* are ordinary Candid: the kernel decodes and rejects malformed
// payloads before app code runs. Handler *outputs* are a Blob carrying this
// format, so the calling side can parse a hostile reply with bounded byte
// arithmetic instead of handing it to `from_candid`, which traps.
//
// Every message is magic, type, version, then fixed fields. Integers are
// big-endian; text, blobs, and arrays are length-prefixed and capped before any
// allocation; and a decoder rejects trailing bytes so two different byte strings
// can never mean the same message.
//
// One version is current and it is the only one read or written. Version 3
// removes the directory that used to ride along on a catalog and a trade, and
// replaces the announce message with a directory message that is asked for. A
// message in an older layout is refused rather than misread, which is the one
// thing the version byte exists to do.
module {
    public let MAGIC : [Nat8] = [0x43, 0x53, 0x57, 0x31]; // CSW1
    public let WIRE_VERSION : Nat8 = 3;
    public let MAX_MESSAGE_BYTES : Nat = 65_536;

    public let MAX_DESIGNS : Nat = 10;
    // A design id travels as a u16, so this is the largest one a catalogue can
    // name. An id past it did not come from a peer and cannot name a chip
    // anybody was shown.
    public let MAX_DESIGN_ID : Nat = 65_535;
    // One page of a directory reply. At 29 bytes a principal plus its length
    // byte, a full page is 3840 bytes, inside the route's 8 KB ceiling.
    public let MAX_DIRECTORY_PAGE : Nat = 128;
    public let MAX_TITLE_BYTES : Nat = 192;
    public let MAX_SHAPE_ID_BYTES : Nat = 32;
    public let MAX_CODE_BYTES : Nat = 64;
    public let MAX_PRINCIPAL_BYTES : Nat = 29;

    // Requirement flags. Nothing else may be set: an unknown bit is a message
    // from a future we cannot read, and it is refused rather than ignored.
    let FLAG_APPROVAL : Nat = 1;
    let FLAG_MIN_COLORS : Nat = 2;
    let FLAG_MAX_COVERAGE : Nat = 4;
    let FLAG_NSFW_RULE : Nat = 8;
    let FLAG_NSFW_REQUIRED : Nat = 16;
    let FLAG_KNOWN : Nat = 31;

    // Bounds a requirement must satisfy to have traveled honestly. They match
    // Requirements.mo; a value outside them never becomes a stored requirement.
    let MIN_COLORS_FLOOR : Nat = 2;
    let MAX_COVERAGE_FLOOR : Nat = 1;
    let MAX_COVERAGE_CEILING : Nat = 99;

    let TYPE_CATALOG : Nat8 = 1;
    let TYPE_TRADE : Nat8 = 2;
    let TYPE_DELIVER : Nat8 = 3;
    let TYPE_STATUS : Nat8 = 4;
    let TYPE_DIRECTORY : Nat8 = 5;

    public type NsfwRule = { #disallowed; #required };

    // Structurally the schema's requirement set. It is repeated here rather
    // than imported so the wire stays a description of bytes: a memory version
    // may change without silently changing what peers send each other.
    public type Requirements = {
        approval : Bool;
        min_colors : ?Nat;
        max_coverage : ?Nat;
        nsfw : ?NsfwRule;
    };

    public type Art = {
        shape_id : Text;
        palette : [Nat32];
        pixels : Blob;
    };

    public type Chip = {
        designer : Principal;
        design_id : Nat;
        serial : Nat;
        title : Text;
        art : Art;
        nsfw : Bool;
        design_revision : Nat;
        minted_at_ns : Int;
    };

    public type Design = {
        design_id : Nat;
        title : Text;
        art : Art;
        requirements : Requirements;
        nsfw : Bool;
        design_revision : Nat;
        published_at_ns : Int;
    };

    public type CatalogReply = {
        designs : [Design];
    };

    public type TradeReply = {
        #minted : { chip : Chip };
        #pending;
        #declined : { reason : Text };
        #err : { code : Text };
    };

    public type DeliverReply = {
        #ok;
        #err : { code : Text };
    };

    public type StatusReply = {
        #unknown;
        #pending;
        #minted : { chip : Chip };
        #declined : { reason : Text };
    };

    // One page of a peer's directory. `total` is the whole eligible count, not
    // the page length, so a caller knows whether to ask again without having to
    // infer it from a short reply.
    public type DirectoryReply = {
        entries : [Principal];
        total : Nat;
    };

    // --- Encoding ----------------------------------------------------------

    public func encodeCatalogReply(reply : CatalogReply) : Blob {
        let bytes = header(TYPE_CATALOG);
        let designs = capped<Design>(reply.designs, MAX_DESIGNS);
        appendU16(bytes, designs.size());
        for (design in designs.values()) appendDesign(bytes, design);
        finish(bytes);
    };

    public func encodeTradeReply(reply : TradeReply) : Blob {
        let bytes = header(TYPE_TRADE);
        switch (reply) {
            case (#minted(payload)) {
                List.add(bytes, 0 : Nat8);
                appendChip(bytes, payload.chip);
            };
            case (#pending) List.add(bytes, 1 : Nat8);
            case (#declined(payload)) {
                List.add(bytes, 2 : Nat8);
                appendText(bytes, payload.reason, MAX_CODE_BYTES);
            };
            case (#err(payload)) {
                List.add(bytes, 3 : Nat8);
                appendText(bytes, payload.code, MAX_CODE_BYTES);
            };
        };
        finish(bytes);
    };

    public func encodeDeliverReply(reply : DeliverReply) : Blob {
        let bytes = header(TYPE_DELIVER);
        switch (reply) {
            case (#ok) List.add(bytes, 0 : Nat8);
            case (#err(payload)) {
                List.add(bytes, 1 : Nat8);
                appendText(bytes, payload.code, MAX_CODE_BYTES);
            };
        };
        finish(bytes);
    };

    public func encodeStatusReply(reply : StatusReply) : Blob {
        let bytes = header(TYPE_STATUS);
        switch (reply) {
            case (#unknown) List.add(bytes, 0 : Nat8);
            case (#pending) List.add(bytes, 1 : Nat8);
            case (#minted(payload)) {
                List.add(bytes, 2 : Nat8);
                appendChip(bytes, payload.chip);
            };
            case (#declined(payload)) {
                List.add(bytes, 3 : Nat8);
                appendText(bytes, payload.reason, MAX_CODE_BYTES);
            };
        };
        finish(bytes);
    };

    public func encodeDirectoryReply(reply : DirectoryReply) : Blob {
        let bytes = header(TYPE_DIRECTORY);
        let page = capped<Principal>(reply.entries, MAX_DIRECTORY_PAGE);
        appendU16(bytes, page.size());
        for (entry in page.values()) appendPrincipal(bytes, entry);
        appendU32(bytes, reply.total);
        finish(bytes);
    };

    // --- Decoding ----------------------------------------------------------

    public func decodeCatalogReply(message : Blob) : ?CatalogReply {
        let ?reader = open(message, TYPE_CATALOG) else return null;
        let count = reader.u16();
        if (count > MAX_DESIGNS) return null;
        let designs = List.empty<Design>();
        var index = 0;
        while (index < count and reader.ok()) {
            switch (readDesign(reader)) {
                case (?design) List.add(designs, design);
                case null return null;
            };
            index += 1;
        };
        if (not reader.done()) return null;
        ?{ designs = List.toArray(designs) };
    };

    public func decodeTradeReply(message : Blob) : ?TradeReply {
        let ?reader = open(message, TYPE_TRADE) else return null;
        let variant = reader.u8();
        let reply : TradeReply = switch (variant) {
            case (0) {
                let ?chip = readChip(reader) else return null;
                #minted({ chip });
            };
            case (1) #pending;
            case (2) #declined({ reason = reader.text(MAX_CODE_BYTES) });
            case (3) #err({ code = reader.text(MAX_CODE_BYTES) });
            case (_) return null;
        };
        if (not reader.done()) return null;
        ?reply;
    };

    public func decodeDeliverReply(message : Blob) : ?DeliverReply {
        let ?reader = open(message, TYPE_DELIVER) else return null;
        let reply : DeliverReply = switch (reader.u8()) {
            case (0) #ok;
            case (1) #err({ code = reader.text(MAX_CODE_BYTES) });
            case (_) return null;
        };
        if (not reader.done()) return null;
        ?reply;
    };

    public func decodeStatusReply(message : Blob) : ?StatusReply {
        let ?reader = open(message, TYPE_STATUS) else return null;
        let reply : StatusReply = switch (reader.u8()) {
            case (0) #unknown;
            case (1) #pending;
            case (2) {
                let ?chip = readChip(reader) else return null;
                #minted({ chip });
            };
            case (3) #declined({ reason = reader.text(MAX_CODE_BYTES) });
            case (_) return null;
        };
        if (not reader.done()) return null;
        ?reply;
    };

    public func decodeDirectoryReply(message : Blob) : ?DirectoryReply {
        let ?reader = open(message, TYPE_DIRECTORY) else return null;
        let count = reader.u16();
        if (count > MAX_DIRECTORY_PAGE) return null;
        let entries = List.empty<Principal>();
        var index = 0;
        while (index < count and reader.ok()) {
            List.add(entries, reader.principal());
            index += 1;
        };
        let total = reader.u32();
        if (not reader.ok() or not reader.done()) return null;
        // A page longer than the whole is a peer describing something that
        // cannot exist, and paging on it would never terminate.
        if (List.size(entries) > total) return null;
        ?{ entries = List.toArray(entries); total };
    };

    // --- Writers -----------------------------------------------------------

    func header(messageType : Nat8) : List.List<Nat8> {
        let bytes = List.empty<Nat8>();
        for (byte in MAGIC.values()) List.add(bytes, byte);
        List.add(bytes, messageType);
        List.add(bytes, WIRE_VERSION);
        bytes;
    };

    func finish(bytes : List.List<Nat8>) : Blob {
        Blob.fromArray(List.toArray(bytes));
    };

    func capped<T>(values : [T], limit : Nat) : [T] {
        if (values.size() <= limit) values else Array.tabulate<T>(limit, func(i) { values[i] });
    };

    func appendU8(bytes : List.List<Nat8>, value : Nat) {
        List.add(bytes, Nat8.fromNat(value % 256));
    };

    func appendU16(bytes : List.List<Nat8>, value : Nat) {
        appendU8(bytes, value / 256);
        appendU8(bytes, value);
    };

    func appendU32(bytes : List.List<Nat8>, value : Nat) {
        appendU16(bytes, value / 65_536);
        appendU16(bytes, value);
    };

    func appendU64(bytes : List.List<Nat8>, value : Nat) {
        appendU32(bytes, value / 4_294_967_296);
        appendU32(bytes, value);
    };

    // Our timestamps come from Time.now() and are never negative; a negative
    // would be a local clock fault, and it travels as zero rather than wrapping
    // into an enormous positive value.
    func appendTimestamp(bytes : List.List<Nat8>, value : Int) {
        appendU64(bytes, if (value <= 0) 0 else Int.abs(value));
    };

    func appendText(bytes : List.List<Nat8>, value : Text, limit : Nat) {
        let encoded = Blob.toArray(Text.encodeUtf8(value));
        let length = if (encoded.size() <= limit) encoded.size() else limit;
        appendU16(bytes, length);
        var index = 0;
        while (index < length) {
            List.add(bytes, encoded[index]);
            index += 1;
        };
    };

    func appendBlob(bytes : List.List<Nat8>, value : Blob) {
        appendU16(bytes, value.size());
        for (byte in value.values()) List.add(bytes, byte);
    };

    func appendPrincipal(bytes : List.List<Nat8>, value : Principal) {
        let raw = Principal.toBlob(value);
        let length = if (raw.size() <= MAX_PRINCIPAL_BYTES) raw.size() else 0;
        appendU8(bytes, length);
        if (length > 0) for (byte in raw.values()) List.add(bytes, byte);
    };

    func appendArt(bytes : List.List<Nat8>, art : Art) {
        appendText(bytes, art.shape_id, MAX_SHAPE_ID_BYTES);
        let palette = capped<Nat32>(art.palette, Shape.MAX_PALETTE);
        appendU16(bytes, palette.size());
        for (color in palette.values()) appendU32(bytes, Nat32.toNat(color));
        appendBlob(bytes, art.pixels);
    };

    func appendFlag(bytes : List.List<Nat8>, value : Bool) {
        List.add(bytes, if (value) (1 : Nat8) else (0 : Nat8));
    };

    // One flags byte, then only the values the flags claim are there. A field
    // that is off occupies nothing, so an unrestricted design costs one byte.
    func appendRequirements(bytes : List.List<Nat8>, requirements : Requirements) {
        var flags = 0;
        if (requirements.approval) flags += FLAG_APPROVAL;
        if (requirements.min_colors != null) flags += FLAG_MIN_COLORS;
        if (requirements.max_coverage != null) flags += FLAG_MAX_COVERAGE;
        switch (requirements.nsfw) {
            case (?#disallowed) flags += FLAG_NSFW_RULE;
            case (?#required) flags += FLAG_NSFW_RULE + FLAG_NSFW_REQUIRED;
            case null {};
        };
        appendU8(bytes, flags);
        switch (requirements.min_colors) {
            case (?value) appendU8(bytes, value);
            case null {};
        };
        switch (requirements.max_coverage) {
            case (?value) appendU8(bytes, value);
            case null {};
        };
    };

    func appendChip(bytes : List.List<Nat8>, chip : Chip) {
        appendPrincipal(bytes, chip.designer);
        appendU16(bytes, chip.design_id);
        appendU64(bytes, chip.serial);
        appendText(bytes, chip.title, MAX_TITLE_BYTES);
        appendArt(bytes, chip.art);
        appendFlag(bytes, chip.nsfw);
        appendU64(bytes, chip.design_revision);
        appendTimestamp(bytes, chip.minted_at_ns);
    };

    func appendDesign(bytes : List.List<Nat8>, design : Design) {
        appendU16(bytes, design.design_id);
        appendText(bytes, design.title, MAX_TITLE_BYTES);
        appendArt(bytes, design.art);
        appendRequirements(bytes, design.requirements);
        appendFlag(bytes, design.nsfw);
        appendU64(bytes, design.design_revision);
        appendTimestamp(bytes, design.published_at_ns);
    };

    // --- Reader ------------------------------------------------------------

    // Every read is bounds-checked. A failed read latches `failed`, so a caller
    // may read a whole message and check validity once, and a length that was
    // never really read is zero rather than attacker-chosen.
    class Reader(bytes : [Nat8]) {
        var offset = 0;
        var failed = false;

        public func ok() : Bool = not failed;

        public func done() : Bool = not failed and offset == bytes.size();

        public func fail() { failed := true };

        public func u8() : Nat {
            if (failed or offset >= bytes.size()) {
                failed := true;
                return 0;
            };
            let value = Nat8.toNat(bytes[offset]);
            offset += 1;
            value;
        };

        public func u16() : Nat {
            let high = u8();
            let low = u8();
            high * 256 + low;
        };

        public func u32() : Nat {
            let high = u16();
            let low = u16();
            high * 65_536 + low;
        };

        public func u64() : Nat {
            let high = u32();
            let low = u32();
            high * 4_294_967_296 + low;
        };

        public func raw(length : Nat) : [Nat8] {
            if (failed or length > bytes.size() or offset > bytes.size() - length) {
                failed := true;
                return [];
            };
            let start = offset;
            offset += length;
            Array.tabulate<Nat8>(length, func(i) { bytes[start + i] });
        };

        public func text(limit : Nat) : Text {
            let length = u16();
            if (length > limit) {
                failed := true;
                return "";
            };
            let raw_bytes = raw(length);
            if (failed) return "";
            switch (Text.decodeUtf8(Blob.fromArray(raw_bytes))) {
                case (?value) value;
                case null {
                    failed := true;
                    "";
                };
            };
        };

        public func blob(limit : Nat) : Blob {
            let length = u16();
            if (length > limit) {
                failed := true;
                return "" : Blob;
            };
            Blob.fromArray(raw(length));
        };

        // Anything but 0 or 1 is a byte string we have no meaning for, and two
        // spellings of true would be two encodings of one message.
        public func flag() : Bool {
            switch (u8()) {
                case (0) false;
                case (1) true;
                case (_) {
                    failed := true;
                    false;
                };
            };
        };

        public func principal() : Principal {
            let length = u8();
            if (length == 0 or length > MAX_PRINCIPAL_BYTES) {
                failed := true;
                return Principal.fromBlob(Blob.fromArray([]));
            };
            Principal.fromBlob(Blob.fromArray(raw(length)));
        };
    };

    func open(message : Blob, expected : Nat8) : ?Reader {
        if (message.size() < MAGIC.size() + 2) return null;
        if (message.size() > MAX_MESSAGE_BYTES) return null;
        let bytes = Blob.toArray(message);
        var index = 0;
        while (index < MAGIC.size()) {
            if (bytes[index] != MAGIC[index]) return null;
            index += 1;
        };
        if (bytes[MAGIC.size()] != expected) return null;
        if (bytes[MAGIC.size() + 1] != WIRE_VERSION) return null;
        let reader = Reader(bytes);
        ignore reader.raw(MAGIC.size() + 2);
        ?reader;
    };

    func readArt(reader : Reader) : ?Art {
        let shapeId = reader.text(MAX_SHAPE_ID_BYTES);
        let paletteSize = reader.u16();
        if (not reader.ok() or paletteSize == 0 or paletteSize > Shape.MAX_PALETTE) return null;
        let palette = Array.tabulate<Nat32>(
            paletteSize,
            func(_) { Nat32.fromNat(reader.u32() % 4_294_967_296) },
        );
        let pixels = reader.blob(Shape.PIXEL_COUNT);
        if (not reader.ok()) return null;
        // Art that does not describe a chip we can render is refused here, not
        // repaired later.
        switch (Shape.validateArt(shapeId, paletteSize, pixels)) {
            case (?_code) return null;
            case null {};
        };
        ?{ shape_id = shapeId; palette; pixels };
    };

    func readChip(reader : Reader) : ?Chip {
        let designer = reader.principal();
        let designId = reader.u16();
        let serial = reader.u64();
        let title = reader.text(MAX_TITLE_BYTES);
        if (not reader.ok()) return null;
        let ?art = readArt(reader) else return null;
        let nsfw = reader.flag();
        let designRevision = reader.u64();
        let mintedAt = reader.u64();
        if (not reader.ok()) return null;
        ?{
            designer;
            design_id = designId;
            serial;
            title;
            art;
            nsfw;
            design_revision = designRevision;
            minted_at_ns = mintedAt;
        };
    };

    // A requirement outside its bounds is refused rather than clamped: a peer
    // that asks for a hundred and ninety colors is not describing a chip.
    func readRequirements(reader : Reader) : ?Requirements {
        let flags = reader.u8();
        if (not reader.ok()) return null;
        if (flags > FLAG_KNOWN) return null;
        // The `#required` bit on its own would be a second spelling of "no
        // rule", and one message must have exactly one encoding.
        if (has(flags, FLAG_NSFW_REQUIRED) and not has(flags, FLAG_NSFW_RULE)) return null;
        let minColors = if (has(flags, FLAG_MIN_COLORS)) {
            let value = reader.u8();
            if (value < MIN_COLORS_FLOOR or value > Shape.MAX_PALETTE) return null;
            ?value;
        } else null;
        let maxCoverage = if (has(flags, FLAG_MAX_COVERAGE)) {
            let value = reader.u8();
            if (value < MAX_COVERAGE_FLOOR or value > MAX_COVERAGE_CEILING) return null;
            ?value;
        } else null;
        if (not reader.ok()) return null;
        let nsfw : ?NsfwRule = if (not has(flags, FLAG_NSFW_RULE)) null else if (
            has(flags, FLAG_NSFW_REQUIRED)
        ) ?#required else ?#disallowed;
        ?{
            approval = has(flags, FLAG_APPROVAL);
            min_colors = minColors;
            max_coverage = maxCoverage;
            nsfw;
        };
    };

    func has(flags : Nat, bit : Nat) : Bool = (flags / bit) % 2 == 1;

    func readDesign(reader : Reader) : ?Design {
        let designId = reader.u16();
        let title = reader.text(MAX_TITLE_BYTES);
        if (not reader.ok()) return null;
        let ?art = readArt(reader) else return null;
        let ?requirements = readRequirements(reader) else return null;
        let nsfw = reader.flag();
        let designRevision = reader.u64();
        let publishedAt = reader.u64();
        if (not reader.ok()) return null;
        ?{
            design_id = designId;
            title;
            art;
            requirements;
            nsfw;
            design_revision = designRevision;
            published_at_ns = publishedAt;
        };
    };
}
