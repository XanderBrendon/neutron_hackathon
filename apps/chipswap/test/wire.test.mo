import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import IngressWire "../backend/IngressWire";
import Shape "../backend/Shape";
import Wire "../backend/Wire";

let alice = Principal.fromBlob(Blob.fromArray([0, 1, 1]));
let bob = Principal.fromBlob(Blob.fromArray([0, 2, 1]));

let art : Wire.Art = {
    shape_id = Shape.SHAPE_ID;
    palette = [0x000000, 0xffffff, 0x7fd1c1];
    pixels = Blob.fromArray(
        Array.tabulate<Nat8>(Shape.PIXEL_COUNT, func(i) { Nat8.fromNat(i % 3) })
    );
};

let chip : Wire.Chip = {
    designer = alice;
    design_id = 3;
    serial = 42;
    title = "Sunrise";
    art;
    nsfw = true;
    design_revision = 7;
    minted_at_ns = 1_700_000_000_000_000_000;
};

let requirements : Wire.Requirements = {
    approval = true;
    min_colors = ?6;
    max_coverage = ?40;
    nsfw = ? #disallowed;
};

let design : Wire.Design = {
    design_id = 3;
    title = "Sunrise";
    art;
    requirements;
    nsfw = true;
    design_revision = 7;
    published_at_ns = 1_600_000_000_000_000_000;
};

let directory = [alice, bob];

func bytesOf(blob : Blob) : [Nat8] = Blob.toArray(blob);

func truncated(blob : Blob, keep : Nat) : Blob {
    let bytes = bytesOf(blob);
    Blob.fromArray(Array.tabulate<Nat8>(keep, func(i) { bytes[i] }));
};

func withByte(blob : Blob, index : Nat, value : Nat8) : Blob {
    let bytes = bytesOf(blob);
    Blob.fromArray(
        Array.tabulate<Nat8>(bytes.size(), func(i) { if (i == index) value else bytes[i] })
    );
};

func extended(blob : Blob, extra : Nat) : Blob {
    let bytes = bytesOf(blob);
    Blob.fromArray(
        Array.tabulate<Nat8>(
            bytes.size() + extra,
            func(i) { if (i < bytes.size()) bytes[i] else 0 },
        )
    );
};

// --- Catalog ---------------------------------------------------------------

let catalog : Wire.CatalogReply = { designs = [design] };
let catalogBytes = Wire.encodeCatalogReply(catalog);
let ?decodedCatalog = Wire.decodeCatalogReply(catalogBytes) else Runtime.trap("catalog decode");
assert (decodedCatalog.designs.size() == 1);
assert (decodedCatalog.designs[0].design_id == 3);
assert (decodedCatalog.designs[0].title == "Sunrise");
assert (decodedCatalog.designs[0].requirements == requirements);
assert (decodedCatalog.designs[0].nsfw);
assert (decodedCatalog.designs[0].design_revision == 7);
assert (decodedCatalog.designs[0].published_at_ns == 1_600_000_000_000_000_000);
assert (decodedCatalog.designs[0].art.palette == art.palette);
assert (decodedCatalog.designs[0].art.pixels == art.pixels);
assert (decodedCatalog.designs[0].art.shape_id == Shape.SHAPE_ID);

let emptyCatalog = Wire.encodeCatalogReply({ designs = [] });
let ?decodedEmpty = Wire.decodeCatalogReply(emptyCatalog) else Runtime.trap("empty catalog");
assert (decodedEmpty.designs.size() == 0);

// --- Trade -----------------------------------------------------------------

let minted : Wire.TradeReply = #minted({ chip });
let mintedBytes = Wire.encodeTradeReply(minted);
let ?decodedMinted = Wire.decodeTradeReply(mintedBytes) else Runtime.trap("minted decode");
switch (decodedMinted) {
    case (#minted(payload)) {
        assert (payload.chip.designer == alice);
        assert (payload.chip.design_id == 3);
        assert (payload.chip.serial == 42);
        assert (payload.chip.title == "Sunrise");
        assert (payload.chip.nsfw);
        assert (payload.chip.design_revision == 7);
        assert (payload.chip.minted_at_ns == 1_700_000_000_000_000_000);
        assert (payload.chip.art.pixels == art.pixels);
    };
    case (_) Runtime.trap("expected minted");
};

let ?decodedPending = Wire.decodeTradeReply(Wire.encodeTradeReply(#pending))
else Runtime.trap("pending decode");
assert (decodedPending == #pending);

let ?decodedDeclined = Wire.decodeTradeReply(
    Wire.encodeTradeReply(#declined({ reason = "trade_mode" }))
) else Runtime.trap("declined decode");
switch (decodedDeclined) {
    case (#declined(payload)) assert (payload.reason == "trade_mode");
    case (_) Runtime.trap("expected declined");
};

let ?decodedTradeErr = Wire.decodeTradeReply(Wire.encodeTradeReply(#err({ code = "not_found" })))
else Runtime.trap("err decode");
switch (decodedTradeErr) {
    case (#err(payload)) assert (payload.code == "not_found");
    case (_) Runtime.trap("expected err");
};

// --- Deliver, status, directory --------------------------------------------

let ?deliverOk = Wire.decodeDeliverReply(Wire.encodeDeliverReply(#ok)) else Runtime.trap("deliver ok");
assert (deliverOk == #ok);
let ?deliverErr = Wire.decodeDeliverReply(Wire.encodeDeliverReply(#err({ code = "unknown_trade" })))
else Runtime.trap("deliver err");
switch (deliverErr) {
    case (#err(payload)) assert (payload.code == "unknown_trade");
    case (_) Runtime.trap("expected err");
};

let ?statusUnknown = Wire.decodeStatusReply(Wire.encodeStatusReply(#unknown)) else Runtime.trap("status");
assert (statusUnknown == #unknown);
let ?statusPending = Wire.decodeStatusReply(Wire.encodeStatusReply(#pending)) else Runtime.trap("status");
assert (statusPending == #pending);
let ?statusMinted = Wire.decodeStatusReply(Wire.encodeStatusReply(#minted({ chip })))
else Runtime.trap("status minted");
switch (statusMinted) {
    case (#minted(payload)) assert (payload.chip.serial == 42);
    case (_) Runtime.trap("expected minted");
};
let ?statusDeclined = Wire.decodeStatusReply(Wire.encodeStatusReply(#declined({ reason = "no" })))
else Runtime.trap("status declined");
switch (statusDeclined) {
    case (#declined(payload)) assert (payload.reason == "no");
    case (_) Runtime.trap("expected declined");
};

// A directory page carries the peer's whole eligible count alongside the slice
// they sent, so a crawler knows whether to ask again without inferring it from
// a short reply.
let directoryBytes = Wire.encodeDirectoryReply({ entries = directory; total = 9 });
let ?decodedDirectory = Wire.decodeDirectoryReply(directoryBytes)
else Runtime.trap("directory decode");
assert (decodedDirectory.entries == directory);
assert (decodedDirectory.total == 9);

let ?emptyDirectory = Wire.decodeDirectoryReply(
    Wire.encodeDirectoryReply({ entries = []; total = 0 })
) else Runtime.trap("empty directory");
assert (emptyDirectory.entries.size() == 0);
assert (emptyDirectory.total == 0);

// A full page is inside the route's response ceiling with room to spare.
let fullPage = Wire.encodeDirectoryReply({
    entries = Array.tabulate<Principal>(Wire.MAX_DIRECTORY_PAGE, func(_) { alice });
    total = Wire.MAX_DIRECTORY_PAGE;
});
assert (bytesOf(fullPage).size() <= 8_192);
let ?decodedFull = Wire.decodeDirectoryReply(fullPage) else Runtime.trap("full page");
assert (decodedFull.entries.size() == Wire.MAX_DIRECTORY_PAGE);

// A page longer than the total it claims describes something that cannot exist,
// and a crawler paging on it would never reach the end.
assert (Wire.decodeDirectoryReply(
    Wire.encodeDirectoryReply({ entries = directory; total = 1 })
) == null);

// --- A design that asks for nothing ----------------------------------------

// The flags byte carries every requirement that is off, so an unrestricted
// design costs one byte and still round-trips exactly.
let openDesign : Wire.Design = {
    design with
    requirements = {
        approval = false;
        min_colors = null;
        max_coverage = null;
        nsfw = null;
    };
    nsfw = false;
};
let openBytes = Wire.encodeCatalogReply({ designs = [openDesign] });
let ?decodedOpen = Wire.decodeCatalogReply(openBytes) else Runtime.trap("open catalog");
assert (decodedOpen.designs[0].requirements == openDesign.requirements);
assert (not decodedOpen.designs[0].nsfw);
// Two bytes shorter than the message above: one flags byte with nothing set,
// where the other carried a color minimum and a coverage cap as well.
assert (bytesOf(openBytes).size() + 2 == bytesOf(
    Wire.encodeCatalogReply({ designs = [design] })
).size());

// A rule of `#required` encodes and reads back as itself, not as its opposite.
let requiring = Wire.encodeCatalogReply({
    designs = [{ design with requirements = { requirements with nsfw = ? #required } }];
});
let ?decodedRequiring = Wire.decodeCatalogReply(requiring) else Runtime.trap("required catalog");
assert (decodedRequiring.designs[0].requirements.nsfw == ? #required);

// --- Hostile input ---------------------------------------------------------

// Empty, short, wrong magic, wrong version, unknown type.
assert (Wire.decodeCatalogReply(Blob.fromArray([])) == null);
assert (Wire.decodeCatalogReply(Blob.fromArray([0x43, 0x53, 0x57])) == null);
assert (Wire.decodeCatalogReply(withByte(catalogBytes, 0, 0x44)) == null);
assert (Wire.decodeCatalogReply(withByte(catalogBytes, 5, 9)) == null);
assert (Wire.decodeCatalogReply(withByte(catalogBytes, 4, 9)) == null);
// One version is current. Both older layouts described the same message types
// differently, so a message claiming either is refused rather than read as this
// one — version 2 in particular carried a directory this one does not.
assert (Wire.decodeCatalogReply(withByte(catalogBytes, 5, 2)) == null);
assert (Wire.decodeTradeReply(withByte(mintedBytes, 5, 2)) == null);
assert (Wire.decodeDirectoryReply(withByte(directoryBytes, 5, 2)) == null);
assert (Wire.decodeCatalogReply(withByte(catalogBytes, 5, 1)) == null);
assert (Wire.decodeTradeReply(withByte(mintedBytes, 5, 1)) == null);
assert (Wire.decodeCatalogReply(withByte(catalogBytes, 5, 0)) == null);

// A reply of one type never decodes as another.
assert (Wire.decodeTradeReply(catalogBytes) == null);
assert (Wire.decodeCatalogReply(mintedBytes) == null);
assert (Wire.decodeStatusReply(mintedBytes) == null);
assert (Wire.decodeDirectoryReply(catalogBytes) == null);
assert (Wire.decodeCatalogReply(directoryBytes) == null);

// A directory page is refused on the same terms as every other message:
// truncated, extended, or declaring more entries than the cap allows.
assert (Wire.decodeDirectoryReply(truncated(directoryBytes, 8)) == null);
assert (Wire.decodeDirectoryReply(extended(directoryBytes, 1)) == null);
let overEntries = withByte(withByte(directoryBytes, 6, 1), 7, 0); // 256 > 128
assert (Wire.decodeDirectoryReply(overEntries) == null);

// Truncation at every prefix is rejected rather than trusted.
var cut = 1;
while (cut < bytesOf(catalogBytes).size()) {
    assert (Wire.decodeCatalogReply(truncated(catalogBytes, cut)) == null);
    cut += 37;
};
assert (Wire.decodeTradeReply(truncated(mintedBytes, 12)) == null);

// Trailing bytes are rejected: a decoder must consume exactly the message.
assert (Wire.decodeCatalogReply(extended(catalogBytes, 1)) == null);
assert (Wire.decodeTradeReply(extended(mintedBytes, 4)) == null);

// Declared counts beyond the protocol caps are rejected before allocation.
let overDesigns = withByte(withByte(catalogBytes, 6, 0), 7, 40); // design count 40 > 10
assert (Wire.decodeCatalogReply(overDesigns) == null);

// A payload larger than the accepted ceiling is refused outright.
assert (Wire.decodeCatalogReply(extended(catalogBytes, Wire.MAX_MESSAGE_BYTES)) == null);

// --- Ingress unwrapping ----------------------------------------------------

let payload = Blob.fromArray([1, 2, 3, 4]);
let okFrame = IngressWire.testOkFrame(payload);
assert (IngressWire.unwrapOk(okFrame, 64) == ?payload);
assert (IngressWire.unwrapOk(okFrame, 2) == null);
assert (IngressWire.unwrapOk(truncated(okFrame, bytesOf(okFrame).size() - 1), 64) == null);
assert (IngressWire.unwrapOk(extended(okFrame, 1), 64) == null);
assert (IngressWire.unwrapOk(Blob.fromArray([]), 64) == null);
assert (IngressWire.unwrapOk(withByte(okFrame, 0, 0), 64) == null);
assert (IngressWire.unwrapOk(IngressWire.testNonCanonicalOkFrame(payload), 64) == null);

let blobReturn = IngressWire.testBlobReturnFrame(payload);
assert (IngressWire.unwrapBlobReturn(blobReturn, 64) == ?payload);
assert (IngressWire.unwrapBlobReturn(blobReturn, 2) == null);
assert (IngressWire.unwrapBlobReturn(extended(blobReturn, 1), 64) == null);
assert (IngressWire.unwrapBlobReturn(truncated(blobReturn, 3), 64) == null);
assert (IngressWire.unwrapBlobReturn(okFrame, 64) == null);

// The two layers compose: an #ok wrapper around a blob-returning handler.
let nested = IngressWire.testOkFrame(blobReturn);
let ?inner = IngressWire.unwrapOk(nested, 256) else Runtime.trap("outer unwrap");
assert (IngressWire.unwrapBlobReturn(inner, 64) == ?payload);
