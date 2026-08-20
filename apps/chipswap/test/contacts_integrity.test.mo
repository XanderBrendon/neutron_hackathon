// Chipswap mirrors the Contacts app-call types locally, because the method
// schema generator cannot follow an imported module alias. A mirror that drifts
// from the installed provider is not a Motoko error in this app alone — it
// surfaces as a browser-compiler failure at install time, when the kernel binds
// the real provider into the environment.
//
// This test binds the real Contacts module into Chipswap.AppCalls, so any drift
// is a compile error here instead.

import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import NeutronCapabilities "mo:neutron-capabilities";
import Contacts "../../contacts/backend/main";
import ContactMemory "../../contacts/backend/memory/contacts/v2";
import Chipswap "../backend/main";
import Memory "../backend/memory/chipswap/v2";

let self = Principal.fromBlob(Blob.fromArray([0, 0, 0, 0, 0, 16, 0, 1, 1, 1]));
let peer = Principal.fromBlob(Blob.fromArray([0, 0, 0, 0, 0, 16, 0, 2, 1, 1]));

let contactMem = ContactMemory.init();
let contacts = Contacts.Init({ stable_memory = { contacts = contactMem } });

// The binding under test: real provider functions, Chipswap's declared type.
let appCalls : Chipswap.AppCalls = {
    contacts = {
        contacts_neutron_lookup_v2 = func(request) {
            contacts.contacts_neutron_lookup_v2(request);
        };
        contacts_neutron_search_v2 = func(request) {
            contacts.contacts_neutron_search_v2(request);
        };
    };
};

let memory = Memory.init();
let chipswap = Chipswap.Init({
    stable_memory = { chipswap = memory };
    app_calls = appCalls;
    capabilities = {
        backend_calls = {
            canister_principal = self;
            can_call = func(_canister : Principal, _method : Text) : Bool { true };
            call = func(
                _request : NeutronCapabilities.BackendCallRequestV1
            ) : async* NeutronCapabilities.BackendCallResultV1 {
                #err({ code = "unused"; message = "unused" });
            };
            call_batch = func(
                _requests : [NeutronCapabilities.BackendCallRequestV1]
            ) : async* [NeutronCapabilities.BackendCallResultV1] { [] };
        };
    };
});

// An empty address book answers, so Contacts reads as available.
let empty = chipswap.chipswap_contacts_suggestions({
    search_text = "";
    offset = 0;
    limit = 10;
});
assert (empty.available);
assert (empty.total == 0);
assert (empty.rows.size() == 0);

// A contact holding a Neutron address becomes a suggestion.
Map.add(
    contactMem.contacts,
    Nat.compare,
    1,
    {
        id = 1;
        revision = 1;
        kind = #person;
        name = "Peer One";
        notes = "";
        addresses = [{
            id = 1;
            address_label = null;
            destination = #neutron(peer);
            preferred = false;
        }];
        created_at = 1;
        updated_at = 1;
    },
);
Map.add(contactMem.neutron_index, Principal.compare, peer, 1);
contactMem.revision += 1;

let found = chipswap.chipswap_contacts_suggestions({
    search_text = "";
    offset = 0;
    limit = 10;
});
assert (found.available);
assert (found.total == 1);
assert (found.rows.size() == 1);
assert (found.rows[0].contact_name == "Peer One");
assert (found.rows[0].principal == Principal.toText(peer));
// Suggestions report directory membership so the tile can hide duplicates.
assert (not found.rows[0].in_directory);

switch (chipswap.chipswap_directory_add({ canister = Principal.toText(peer); source = "contacts" })) {
    case (#ok(_)) {};
    case (#err(_)) assert false;
};

let again = chipswap.chipswap_contacts_suggestions({
    search_text = "";
    offset = 0;
    limit = 10;
});
assert (again.rows.size() == 1);
assert (again.rows[0].in_directory);
