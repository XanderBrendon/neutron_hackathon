import Memory "./memory/chipswap/v1";

module {
    public type AppBackendEnvironment = {
        stable_memory : { chipswap : Memory.Mem };
    };

    public type Status = {
        revision : Nat;
    };

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.chipswap;

        public func /*query*/chipswap_status(()) : Status {
            { revision = mem.revision };
        };
    };

    /*---NEUTRON GENERATED BEGIN---*/

public type chipswap_status_Input = (());
public type chipswap_status_Output = Status;

/*---NEUTRON GENERATED END---*/
}
