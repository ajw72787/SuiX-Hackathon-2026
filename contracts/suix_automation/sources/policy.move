/// SuiX Non-Custodial Utility — Policy Contract (Final)
///
/// Single contract, designed to be deployed once and never upgraded.
/// All logic is additive-safe. seal_approve is minimal and stable.
///
/// Architecture:
///   - Config (shared)              — global operator, admin, active wallet registry
///   - Policy (shared)              — per-user access control and rebalance params
///   - AutomationCredential (owned) — Seal-encrypted signing key, lives in user wallet
///   - seal_approve                 — evaluated by Seal key servers: operator + active
///
/// One policy per wallet enforced via Config.active_wallets table.
/// User pays gas for all state changes they initiate.
/// Backend pays gas only for update_last_rebalance after execution.

module suix_policy::policy {

    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::table::{Self, Table};

    // =========================================================================
    // Error codes
    // =========================================================================

    const ENotAuthorized: u64       = 0;
    const ENotAdmin: u64            = 1;
    const EPolicyInactive: u64      = 2;
    const EPolicyNotOwned: u64      = 3;
    const EFrequencyTooSoon: u64    = 4;
    const EAlreadyActive: u64       = 5;
    const EWrongPolicy: u64         = 6;
    const EWalletAlreadyActive: u64 = 7; // One policy per wallet

    // =========================================================================
    // Config — shared, one per deployment
    // =========================================================================

    public struct Config has key {
        id: UID,
        /// Deployment wallet. Only address that can rotate operator or transfer admin.
        /// Should be moved to multisig post-launch.
        admin: address,
        /// Backend bot wallet today. Becomes Nautilus enclave wallet post-hackathon.
        /// One call to update_authorized_operator — all policies update instantly.
        authorized_operator: address,
        /// Registry of wallets with active policies.
        /// Enforces one policy per wallet. Checked on activate, cleared on delete.
        active_wallets: Table<address, ID>,
    }

    // =========================================================================
    // Policy — shared, one per user
    // =========================================================================

    public struct Policy has key, store {
        id: UID,
        owner: address,
        drift_threshold_bps: u64,
        frequency_secs: u64,
        active: bool,
        created_at: u64,
        last_rebalance: u64,
    }

    // =========================================================================
    // AutomationCredential — owned by user, lives in their wallet
    //
    // Holds the Seal-encrypted signing key for the user's dedicated utility wallet.
    // Named to be non-descriptive on-chain — does not reveal contents.
    // Backend reads encrypted_blob from chain on demand. Never stored off-chain.
    // =========================================================================

    public struct AutomationCredential has key, store {
        id: UID,
        owner: address,
        policy_id: ID,
        encrypted_blob: vector<u8>,
    }

    // =========================================================================
    // Events
    // =========================================================================

    public struct PolicyActivated has copy, drop {
        policy_id: ID,
        automation_credential_id: ID,
        owner: address,
        drift_threshold_bps: u64,
        frequency_secs: u64,
        created_at: u64,
    }

    public struct PolicyDeactivated has copy, drop {
        policy_id: ID,
        owner: address,
    }

    public struct PolicyReactivated has copy, drop {
        policy_id: ID,
        owner: address,
    }

    public struct PolicyUpdated has copy, drop {
        policy_id: ID,
        owner: address,
        new_drift_threshold_bps: u64,
        new_frequency_secs: u64,
    }

    public struct AutomationCredentialUpdated has copy, drop {
        policy_id: ID,
        automation_credential_id: ID,
        owner: address,
    }

    /// Emitted when user fully cancels automation.
    /// Backend scanning service uses this to immediately remove the wallet
    /// from the scan list rather than waiting for the next cycle.
    public struct AutomationCancelled has copy, drop {
        policy_id: ID,
        owner: address,
        cancelled_at: u64,
    }

    public struct LastRebalanceUpdated has copy, drop {
        policy_id: ID,
        owner: address,
        timestamp: u64,
    }

    public struct OperatorRotated has copy, drop {
        old_operator: address,
        new_operator: address,
    }

    // =========================================================================
    // Init
    // =========================================================================

    fun init(ctx: &mut TxContext) {
        let config = Config {
            id: object::new(ctx),
            admin: ctx.sender(),
            authorized_operator: ctx.sender(),
            active_wallets: table::new(ctx),
        };
        transfer::share_object(config);
    }

    // =========================================================================
    // Admin functions
    // =========================================================================

    public fun update_authorized_operator(
        config: &mut Config,
        new_operator: address,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == config.admin, ENotAdmin);
        let old_operator = config.authorized_operator;
        config.authorized_operator = new_operator;
        event::emit(OperatorRotated { old_operator, new_operator });
    }

    public fun transfer_admin(
        config: &mut Config,
        new_admin: address,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == config.admin, ENotAdmin);
        config.admin = new_admin;
    }

    // =========================================================================
    // User functions
    // =========================================================================

    /// Primary activation — creates Policy (shared) + AutomationCredential (owned).
    /// Enforces one active policy per wallet via Config.active_wallets registry.
    /// encrypted_blob is produced by SealClient.encrypt() on the frontend before
    /// this transaction is submitted. User pays gas. One signature, two objects.
    #[allow(lint(self_transfer))]
    public fun activate_policy(
        config: &mut Config,
        drift_threshold_bps: u64,
        frequency_secs: u64,
        encrypted_blob: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        // Enforce one policy per wallet
        assert!(
            !table::contains(&config.active_wallets, ctx.sender()),
            EWalletAlreadyActive
        );

        let now = clock::timestamp_ms(clock);

        let policy = Policy {
            id: object::new(ctx),
            owner: ctx.sender(),
            drift_threshold_bps,
            frequency_secs,
            active: true,
            created_at: now,
            last_rebalance: 0,
        };
        let policy_id = object::id(&policy);

        let credential = AutomationCredential {
            id: object::new(ctx),
            owner: ctx.sender(),
            policy_id,
            encrypted_blob,
        };
        let credential_id = object::id(&credential);

        // Register wallet as active — prevents duplicate policies
        table::add(&mut config.active_wallets, ctx.sender(), policy_id);

        event::emit(PolicyActivated {
            policy_id,
            automation_credential_id: credential_id,
            owner: ctx.sender(),
            drift_threshold_bps,
            frequency_secs,
            created_at: now,
        });

        // Policy shared — backend and Seal can reference it in PTBs
        transfer::share_object(policy);
        // AutomationCredential owned by user — lives in their wallet
        transfer::transfer(credential, ctx.sender());
    }

    public fun deactivate_policy(
        policy: &mut Policy,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == policy.owner, EPolicyNotOwned);
        policy.active = false;
        event::emit(PolicyDeactivated {
            policy_id: object::id(policy),
            owner: policy.owner,
        });
    }

    public fun reactivate_policy(
        policy: &mut Policy,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == policy.owner, EPolicyNotOwned);
        assert!(!policy.active, EAlreadyActive);
        policy.active = true;
        event::emit(PolicyReactivated {
            policy_id: object::id(policy),
            owner: policy.owner,
        });
    }

    public fun update_policy(
        policy: &mut Policy,
        new_drift_threshold_bps: u64,
        new_frequency_secs: u64,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == policy.owner, EPolicyNotOwned);
        policy.drift_threshold_bps = new_drift_threshold_bps;
        policy.frequency_secs = new_frequency_secs;
        event::emit(PolicyUpdated {
            policy_id: object::id(policy),
            owner: policy.owner,
            new_drift_threshold_bps,
            new_frequency_secs,
        });
    }

    /// Replace the encrypted blob — e.g. user rotates their signing key.
    /// Only policy owner can call this.
    public fun update_automation_credential(
        policy: &Policy,
        credential: &mut AutomationCredential,
        new_encrypted_blob: vector<u8>,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == policy.owner, EPolicyNotOwned);
        assert!(credential.policy_id == object::id(policy), EWrongPolicy);
        credential.encrypted_blob = new_encrypted_blob;
        event::emit(AutomationCredentialUpdated {
            policy_id: object::id(policy),
            automation_credential_id: object::id(credential),
            owner: policy.owner,
        });
    }

    /// Delete the AutomationCredential object.
    /// Destroys the object, reclaims storage rebate in SUI for the user.
    /// Call this after deactivating if you want to clean up your wallet.
    public fun delete_automation_credential(
        credential: AutomationCredential,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == credential.owner, EPolicyNotOwned);
        let AutomationCredential {
            id,
            owner: _,
            policy_id: _,
            encrypted_blob: _,
        } = credential;
        object::delete(id);
    }

    /// Convenience: deactivate policy + delete credential + remove from registry.
    /// One transaction to fully cancel automation.
    /// Emits AutomationCancelled so backend removes wallet from scan list immediately.
    /// User reclaims storage rebate from the deleted credential object.
    public fun deactivate_and_delete(
        config: &mut Config,
        policy: &mut Policy,
        credential: AutomationCredential,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == policy.owner, EPolicyNotOwned);
        assert!(credential.policy_id == object::id(policy), EWrongPolicy);

        let now = clock::timestamp_ms(clock);
        let policy_id = object::id(policy);

        // Deactivate policy
        policy.active = false;

        // Remove from active wallet registry — allows re-activation later
        if (table::contains(&config.active_wallets, ctx.sender())) {
            table::remove(&mut config.active_wallets, ctx.sender());
        };

        // Delete credential object — user reclaims storage rebate
        let AutomationCredential {
            id,
            owner: _,
            policy_id: _,
            encrypted_blob: _,
        } = credential;
        object::delete(id);

        event::emit(AutomationCancelled {
            policy_id,
            owner: ctx.sender(),
            cancelled_at: now,
        });
    }

    // =========================================================================
    // Backend operator function
    // =========================================================================

    public fun update_last_rebalance(
        config: &Config,
        policy: &mut Policy,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == config.authorized_operator, ENotAuthorized);
        let now = clock::timestamp_ms(clock);
        let window_ms = policy.frequency_secs * 1000;
        if (policy.last_rebalance > 0) {
            assert!(now >= policy.last_rebalance + window_ms, EFrequencyTooSoon);
        };
        policy.last_rebalance = now;
        event::emit(LastRebalanceUpdated {
            policy_id: object::id(policy),
            owner: policy.owner,
            timestamp: now,
        });
    }

    // =========================================================================
    // Seal integration
    // =========================================================================

    /// Evaluated by Seal key servers via dry_run_transaction_block.
    /// Grants decryption if sender == authorized_operator AND policy is active.
    /// This function is intentionally minimal and will never need to change.
    entry fun seal_approve(
        id: vector<u8>,
        config: &Config,
        policy: &Policy,
        ctx: &TxContext,
    ) {
        let _ = id;
        assert!(ctx.sender() == config.authorized_operator, ENotAuthorized);
        assert!(policy.active, EPolicyInactive);
    }

    // =========================================================================
    // Read-only accessors
    // =========================================================================

    public fun is_active(policy: &Policy): bool { policy.active }
    public fun owner(policy: &Policy): address { policy.owner }
    public fun drift_threshold_bps(policy: &Policy): u64 { policy.drift_threshold_bps }
    public fun frequency_secs(policy: &Policy): u64 { policy.frequency_secs }
    public fun last_rebalance(policy: &Policy): u64 { policy.last_rebalance }
    public fun created_at(policy: &Policy): u64 { policy.created_at }
    public fun authorized_operator(config: &Config): address { config.authorized_operator }
    public fun admin(config: &Config): address { config.admin }
    public fun has_active_policy(config: &Config, wallet: address): bool {
        table::contains(&config.active_wallets, wallet)
    }
    public fun encrypted_blob(credential: &AutomationCredential): vector<u8> {
        credential.encrypted_blob
    }
    public fun credential_owner(credential: &AutomationCredential): address {
        credential.owner
    }
    public fun credential_policy_id(credential: &AutomationCredential): ID {
        credential.policy_id
    }
}
