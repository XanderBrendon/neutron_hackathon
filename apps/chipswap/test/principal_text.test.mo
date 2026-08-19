import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import PrincipalText "../backend/PrincipalText";

// A management-canister id and an ordinary canister id round-trip exactly.
let ?management = PrincipalText.parse("aaaaa-aa") else Runtime.trap("aaaaa-aa");
assert (Principal.toText(management) == "aaaaa-aa");

let sample = Principal.fromBlob(Blob.fromArray([0, 0, 0, 0, 0, 16, 0, 1, 1, 1]));
let sampleText = Principal.toText(sample);
let ?parsed = PrincipalText.parse(sampleText) else Runtime.trap("round trip");
assert (Principal.toText(parsed) == sampleText);
assert (PrincipalText.parseCanister(sampleText) != null);

// Surrounding whitespace is tolerated; the decoded value is unchanged.
let ?padded = PrincipalText.parse("  " # sampleText # "  ") else Runtime.trap("padded");
assert (Principal.toText(padded) == sampleText);

// Malformed input is refused rather than trapping.
assert (PrincipalText.parse("") == null);
assert (PrincipalText.parse("not-a-principal") == null);
assert (PrincipalText.parse("AAAAA-AA") == null); // upper case is not canonical
assert (PrincipalText.parse("aaaaa-a") == null); // wrong checksum body
assert (PrincipalText.parse("aaaa-aa") == null); // short group
assert (PrincipalText.parse("aaaaaa-aa") == null); // long group
assert (PrincipalText.parse("aaaaa--aa") == null); // empty group
assert (PrincipalText.parse("-aaaaa-aa") == null);
assert (PrincipalText.parse("aaaaa-aa-") == null);
assert (PrincipalText.parse("aaaa1-aa") == null); // '1' is not in the alphabet
assert (PrincipalText.parse("aaaaa-aa ", ) == ?management);

// A self-authenticating principal is not a canister.
let user = Principal.fromBlob(
    Blob.fromArray([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
        17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 2,
    ])
);
let userText = Principal.toText(user);
assert (PrincipalText.parse(userText) != null);
assert (PrincipalText.parseCanister(userText) == null);
