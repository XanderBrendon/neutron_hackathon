import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat8 "mo:core/Nat8";

// Exact, non-trapping unwrapping for the two Candid layers around a peer's
// reply. `from_candid` traps on malformed input, so a hostile peer could abort
// our update simply by answering with garbage. Both layers here are constant
// byte prefixes plus one canonical LEB128 length, which is cheap to check by
// hand and impossible to trap on.
module {
    // Canonical Candid type table, one result argument, and the #ok variant tag
    // for neutron-capabilities.PublicIngressResultV1.
    let OK_PREFIX : [Nat8] = [
        68, 73, 68, 76, 3, 107, 2, 156, 194, 1, 2, 229, 142, 180, 2, 1,
        107, 10, 254, 254, 203, 133, 1, 127, 149, 239, 154, 175,
        1, 127, 152, 153, 210, 236, 1, 127, 222, 254, 203, 140, 2, 127,
        187, 145, 186, 249, 3, 127, 185, 170, 128, 137, 4, 127, 210, 169,
        200, 152, 4, 127, 214, 229, 202, 198, 4, 127, 180, 156, 252, 217,
        12, 127, 144, 145, 208, 173, 13, 127, 109, 123, 1, 0, 0,
    ];

    // "DIDL", one type (vec nat8), one argument of that type: the encoding of a
    // handler whose declared return type is Blob.
    let BLOB_RETURN_PREFIX : [Nat8] = [68, 73, 68, 76, 1, 109, 123, 1, 0];

    public func unwrapOk(reply : Blob, maximum : Nat) : ?Blob {
        unwrap(reply, OK_PREFIX, maximum);
    };

    public func unwrapBlobReturn(reply : Blob, maximum : Nat) : ?Blob {
        unwrap(reply, BLOB_RETURN_PREFIX, maximum);
    };

    func unwrap(reply : Blob, prefix : [Nat8], maximum : Nat) : ?Blob {
        if (reply.size() < prefix.size() + 1) return null;
        // A route is capped well below 2^21 bytes. Four LEB bytes leave one
        // bounded malformed-byte margin while the canonical parser rejects it.
        if (reply.size() > prefix.size() + 4 + maximum) return null;
        let bytes = Blob.toArray(reply);
        var prefixIndex = 0;
        while (prefixIndex < prefix.size()) {
            if (bytes[prefixIndex] != prefix[prefixIndex]) return null;
            prefixIndex += 1;
        };

        var index = prefix.size();
        var length = 0;
        var multiplier = 1;
        var count = 0;
        label leb loop {
            if (index >= bytes.size() or count >= 4) return null;
            let byte = Nat8.toNat(bytes[index]);
            let low = byte % 128;
            if (length > maximum) return null;
            if (low > (maximum - length) / multiplier) return null;
            length += low * multiplier;
            index += 1;
            count += 1;
            if (byte < 128) {
                // Reject non-canonical forms such as 0x80 0x00.
                if (count > 1 and low == 0) return null;
                break leb;
            };
            multiplier *= 128;
        };
        if (length > maximum or index + length != bytes.size()) return null;
        ?Array.toBlob(
            Array.tabulate<Nat8>(length, func(offset) { bytes[index + offset] })
        );
    };

    // Test fixtures. These build the exact frames a real kernel dispatcher and a
    // Blob-returning handler produce, so the decoders above are checked against
    // the encoding they claim to accept rather than against themselves.
    public func testOkFrame(payload : Blob) : Blob {
        frame(OK_PREFIX, payload, false);
    };

    public func testNonCanonicalOkFrame(payload : Blob) : Blob {
        frame(OK_PREFIX, payload, true);
    };

    public func testBlobReturnFrame(payload : Blob) : Blob {
        frame(BLOB_RETURN_PREFIX, payload, false);
    };

    public func testNonCanonicalBlobReturnFrame(payload : Blob) : Blob {
        frame(BLOB_RETURN_PREFIX, payload, true);
    };

    func frame(prefix : [Nat8], payload : Blob, nonCanonical : Bool) : Blob {
        let bytes = List.empty<Nat8>();
        for (byte in prefix.values()) List.add(bytes, byte);
        if (nonCanonical) {
            // Same value, redundant continuation byte.
            var remaining = payload.size();
            List.add(bytes, Nat8.fromNat(remaining % 128 + 128));
            remaining /= 128;
            List.add(bytes, Nat8.fromNat(remaining % 128 + 128));
            remaining /= 128;
            List.add(bytes, Nat8.fromNat(remaining % 128));
        } else {
            var remaining = payload.size();
            label leb loop {
                let low = remaining % 128;
                remaining /= 128;
                if (remaining == 0) {
                    List.add(bytes, Nat8.fromNat(low));
                    break leb;
                };
                List.add(bytes, Nat8.fromNat(low + 128));
            };
        };
        for (byte in payload.values()) List.add(bytes, byte);
        Blob.fromArray(List.toArray(bytes));
    };
}
