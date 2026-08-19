import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

// Non-trapping textual principal parsing.
//
// `Principal.fromText` traps on malformed input, so owner-supplied text can
// never reach it directly. This decodes the grouped base32 form itself, rebuilds
// the principal from the decoded body, and accepts the result only when it
// re-encodes to exactly the same text. That round trip also proves the checksum,
// because `toText` recomputes it.
module {
    let ALPHABET : Text = "abcdefghijklmnopqrstuvwxyz234567";
    let GROUP : Nat = 5;
    let MAX_TEXT_CHARS : Nat = 63;
    let CHECKSUM_BYTES : Nat = 4;
    let MAX_BODY_BYTES : Nat = 29;

    public func parse(value : Text) : ?Principal {
        let trimmed = Text.trim(value, #predicate(func(c : Char) { c <= ' ' }));
        if (trimmed.size() == 0 or trimmed.size() > MAX_TEXT_CHARS) return null;

        let characters = Text.toArray(trimmed);
        let symbols = List.empty<Nat>();
        var groupLength = 0;
        var index = 0;
        while (index < characters.size()) {
            let character = characters[index];
            if (character == '-') {
                // Every group but the last is exactly five characters, and a
                // group is never empty.
                if (groupLength != GROUP) return null;
                groupLength := 0;
            } else {
                let ?symbol = symbolOf(character) else return null;
                if (groupLength == GROUP) return null;
                List.add(symbols, symbol);
                groupLength += 1;
            };
            index += 1;
        };
        if (groupLength == 0) return null;

        let ?decoded = decodeBase32(List.toArray(symbols)) else return null;
        // The management canister id has an empty body, so four bytes of pure
        // checksum is a valid decoding.
        if (decoded.size() < CHECKSUM_BYTES) return null;
        let bodyLength : Nat = decoded.size() - CHECKSUM_BYTES;
        if (bodyLength > MAX_BODY_BYTES) return null;

        let body = List.empty<Nat8>();
        var byteIndex = CHECKSUM_BYTES;
        while (byteIndex < decoded.size()) {
            List.add(body, decoded[byteIndex]);
            byteIndex += 1;
        };
        let candidate = Principal.fromBlob(Blob.fromArray(List.toArray(body)));
        if (Principal.toText(candidate) != trimmed) return null;
        ?candidate;
    };

    public func parseCanister(value : Text) : ?Principal {
        let ?candidate = parse(value) else return null;
        if (not Principal.isCanister(candidate)) return null;
        ?candidate;
    };

    func symbolOf(character : Char) : ?Nat {
        var index = 0;
        for (candidate in ALPHABET.chars()) {
            if (candidate == character) return ?index;
            index += 1;
        };
        null;
    };

    // Five bits per symbol, most significant first. Any leftover bits must be
    // zero, which is what the canonical encoder produces.
    func decodeBase32(symbols : [Nat]) : ?[Nat8] {
        let bytes = List.empty<Nat8>();
        var accumulator = 0;
        var bits = 0;
        for (symbol in symbols.values()) {
            accumulator := accumulator * 32 + symbol;
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                let divisor = powerOfTwo(bits);
                let byte = accumulator / divisor;
                accumulator := accumulator % divisor;
                if (byte > 255) return null;
                List.add(bytes, Nat8.fromNat(byte));
            };
        };
        if (accumulator != 0) return null;
        ?List.toArray(bytes);
    };

    func powerOfTwo(exponent : Nat) : Nat {
        var value = 1;
        var index = 0;
        while (index < exponent) {
            value *= 2;
            index += 1;
        };
        value;
    };
}
