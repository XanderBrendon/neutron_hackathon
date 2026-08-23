import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import IngressWire "../backend/IngressWire";
import Wire "../backend/Wire";
import Fixtures "./fixtures/catalog_wire";

// The fixture file is the contract between the Motoko decoder and the
// TypeScript one. A "refusal" fixture the Motoko decoder happens to accept
// would let both sides agree on a message neither should read, so every case
// is asserted here as well as in test/wire.test.ts.

func lookup(entries : [(Text, Text)], name : Text) : Text {
    for ((key, value) in entries.values()) {
        if (key == name) return value;
    };
    Runtime.trap("fixture missing: " # name);
};

for ((name, hex) in Fixtures.valid.values()) {
    let ?bytes = Fixtures.unhex(hex) else Runtime.trap("fixture is not hex: " # name);
    switch (Wire.decodeCatalogReply(Blob.fromArray(bytes))) {
        case (?_) {};
        case null Runtime.trap("valid fixture refused: " # name);
    };
};

for ((name, hex) in Fixtures.invalid.values()) {
    let ?bytes = Fixtures.unhex(hex) else Runtime.trap("fixture is not hex: " # name);
    switch (Wire.decodeCatalogReply(Blob.fromArray(bytes))) {
        case (?_) Runtime.trap("invalid fixture accepted: " # name);
        case null {};
    };
};

// The valid fixtures are only useful if they carry the values the TypeScript
// test asserts. Checking them here is what makes the two suites one check.
let ?emptyBytes = Fixtures.unhex(lookup(Fixtures.valid, "empty")) else Runtime.trap("empty missing");
let ?empty = Wire.decodeCatalogReply(Blob.fromArray(emptyBytes)) else Runtime.trap("empty refused");
if (empty.designs.size() != 0) Runtime.trap("empty carried designs");

let ?openBytes = Fixtures.unhex(lookup(Fixtures.valid, "open_single")) else Runtime.trap("open_single missing");
let ?open = Wire.decodeCatalogReply(Blob.fromArray(openBytes)) else Runtime.trap("open_single refused");
if (open.designs.size() != 1) Runtime.trap("open_single is not one design");
let openDesign = open.designs[0];
if (openDesign.design_id != 1) Runtime.trap("open_single lost its id");
if (openDesign.title != "Open Water") Runtime.trap("open_single lost its title");
if (openDesign.design_revision != 4) Runtime.trap("open_single lost its revision");
if (openDesign.art.palette.size() != 3) Runtime.trap("open_single lost its palette");
if (openDesign.requirements.approval) Runtime.trap("open_single gained an approval rule");
if (openDesign.requirements.nsfw != null) Runtime.trap("open_single gained a tag rule");

let ?strictBytes = Fixtures.unhex(lookup(Fixtures.valid, "strict_single")) else Runtime.trap("strict_single missing");
let ?strict = Wire.decodeCatalogReply(Blob.fromArray(strictBytes)) else Runtime.trap("strict_single refused");
let strictDesign = strict.designs[0];
if (strictDesign.title != "Sunrise \u{e9}\u{4e2d}") Runtime.trap("strict_single lost its multi-byte title");
if (strictDesign.requirements.min_colors != ?6) Runtime.trap("strict_single lost min_colors");
if (strictDesign.requirements.max_coverage != ?40) Runtime.trap("strict_single lost max_coverage");
if (strictDesign.requirements.nsfw != ? #disallowed) Runtime.trap("strict_single lost its tag rule");
// The largest u64 there is. TypeScript carries this as text for this reason.
if (strictDesign.design_revision != 18_446_744_073_709_551_615) {
    Runtime.trap("strict_single rounded its revision");
};

let ?requiredBytes = Fixtures.unhex(lookup(Fixtures.valid, "required_tag")) else Runtime.trap("required_tag missing");
let ?required = Wire.decodeCatalogReply(Blob.fromArray(requiredBytes)) else Runtime.trap("required_tag refused");
if (required.designs[0].requirements.nsfw != ? #required) {
    Runtime.trap("required_tag did not decode as required");
};

let ?threeBytes = Fixtures.unhex(lookup(Fixtures.valid, "three")) else Runtime.trap("three missing");
let ?three = Wire.decodeCatalogReply(Blob.fromArray(threeBytes)) else Runtime.trap("three refused");
if (three.designs.size() != 3) Runtime.trap("three is not three designs");
if (three.designs[0].design_id != 1 or three.designs[1].design_id != 9 or three.designs[2].design_id != 2) {
    Runtime.trap("three lost its order");
};

let ?tenBytes = Fixtures.unhex(lookup(Fixtures.valid, "full_ten")) else Runtime.trap("full_ten missing");
let ?ten = Wire.decodeCatalogReply(Blob.fromArray(tenBytes)) else Runtime.trap("full_ten refused");
if (ten.designs.size() != 10) Runtime.trap("full_ten is not ten designs");

// The frame the message travels inside. The client had a decoder for the
// message and none for the frame, so every good reply was refused; asserting
// both layers here is what keeps the two suites checking the same thing.
for ((name, hex) in Fixtures.envelope.values()) {
    let ?bytes = Fixtures.unhex(hex) else Runtime.trap("fixture is not hex: " # name);
    let frame = Blob.fromArray(bytes);
    let ?payload = IngressWire.unwrapBlobReturn(frame, Wire.MAX_MESSAGE_BYTES) else {
        Runtime.trap("valid envelope refused: " # name);
    };
    switch (Wire.decodeCatalogReply(payload)) {
        case (?_) {};
        case null Runtime.trap("envelope carried an unreadable catalog: " # name);
    };
};

for ((name, hex) in Fixtures.envelope_invalid.values()) {
    let ?bytes = Fixtures.unhex(hex) else Runtime.trap("fixture is not hex: " # name);
    switch (IngressWire.unwrapBlobReturn(Blob.fromArray(bytes), Wire.MAX_MESSAGE_BYTES)) {
        case (?_) Runtime.trap("invalid envelope accepted: " # name);
        case null {};
    };
};

// The frame around open_single must yield exactly open_single, or the two
// suites are asserting different bytes while reading one fixture file.
let ?frameHex = Fixtures.unhex(lookup(Fixtures.envelope, "one_design")) else Runtime.trap("one_design missing");
let ?singleHex = Fixtures.unhex(lookup(Fixtures.valid, "open_single")) else Runtime.trap("open_single missing");
let ?unwrapped = IngressWire.unwrapBlobReturn(Blob.fromArray(frameHex), Wire.MAX_MESSAGE_BYTES) else {
    Runtime.trap("one_design refused");
};
if (unwrapped != Blob.fromArray(singleHex)) Runtime.trap("the frame did not carry open_single");

// --- Directory pages -------------------------------------------------------
//
// The crawl reads this message in the browser now, so this file guards it the
// same way it guards a catalog: a refusal the Motoko decoder happens to accept
// would let both sides agree on a page neither should read.

for ((name, hex) in Fixtures.directory.values()) {
    let ?bytes = Fixtures.unhex(hex) else Runtime.trap("fixture is not hex: " # name);
    switch (Wire.decodeDirectoryReply(Blob.fromArray(bytes))) {
        case (?_) {};
        case null Runtime.trap("valid directory fixture refused: " # name);
    };
};

for ((name, hex) in Fixtures.directory_invalid.values()) {
    let ?bytes = Fixtures.unhex(hex) else Runtime.trap("fixture is not hex: " # name);
    switch (Wire.decodeDirectoryReply(Blob.fromArray(bytes))) {
        case (?_) Runtime.trap("invalid directory fixture accepted: " # name);
        case null {};
    };
};

let ?dirEmptyBytes = Fixtures.unhex(lookup(Fixtures.directory, "empty")) else Runtime.trap("directory empty missing");
let ?dirEmpty = Wire.decodeDirectoryReply(Blob.fromArray(dirEmptyBytes)) else Runtime.trap("directory empty refused");
if (dirEmpty.entries.size() != 0) Runtime.trap("directory empty carried entries");
if (dirEmpty.total != 0) Runtime.trap("directory empty claimed a total");

// The principal the TypeScript suite asserts as text. Both sides reading one
// address out of one byte string is the whole point of the shared fixture.
let ?dirOneBytes = Fixtures.unhex(lookup(Fixtures.directory, "one")) else Runtime.trap("directory one missing");
let ?dirOne = Wire.decodeDirectoryReply(Blob.fromArray(dirOneBytes)) else Runtime.trap("directory one refused");
if (dirOne.entries.size() != 1) Runtime.trap("directory one is not one entry");
if (Principal.toText(dirOne.entries[0]) != "3wvx3-yaaaa-aaaay-aacuq-cai") {
    Runtime.trap("directory one lost its principal");
};
if (dirOne.total != 1) Runtime.trap("directory one lost its total");

let ?dirPartialBytes = Fixtures.unhex(lookup(Fixtures.directory, "partial_page")) else Runtime.trap("partial_page missing");
let ?dirPartial = Wire.decodeDirectoryReply(Blob.fromArray(dirPartialBytes)) else Runtime.trap("partial_page refused");
if (dirPartial.entries.size() != 3) Runtime.trap("partial_page is not three entries");
if (Principal.toText(dirPartial.entries[1]) != "233tv-xiaaa-aaaay-aacta-cai") {
    Runtime.trap("partial_page lost its order");
};
// The number that tells a crawl to ask again, not the length of this page.
if (dirPartial.total != 11) Runtime.trap("partial_page lost its total");

let ?dirFullBytes = Fixtures.unhex(lookup(Fixtures.directory, "full_page")) else Runtime.trap("full_page missing");
let ?dirFull = Wire.decodeDirectoryReply(Blob.fromArray(dirFullBytes)) else Runtime.trap("full_page refused");
if (dirFull.entries.size() != Wire.MAX_DIRECTORY_PAGE) Runtime.trap("full_page is not a full page");
