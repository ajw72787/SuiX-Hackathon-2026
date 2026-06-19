/// SuiX — Notification Credential Contract
///
/// Mirrors policy.move exactly:
///   - Config (shared)                  — operator + admin, one per deployment
///   - NotificationPolicy (shared)      — per-user active flag, passed to seal_approve
///   - NotificationCredential (owned)   — Seal-encrypted Telegram handle, lives in user wallet
///   - seal_approve                     — operator + active check, identical pattern to policy.move
///
/// The credential never touches a PTB. seal_approve takes Config + Policy (both shared),
/// exactly as policy.move takes Config + Policy. The bot can reference both as
/// sharedObjectRef without owning either.

module suix_notification::notification {

    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::table::{Self, Table};

    // =========================================================================
    // Error codes
    // =========================================================================

    const ENotAuthorized: u64        = 0;
    const ENotAdmin: u64             = 1;
    const EPolicyInactive: u64       = 2;
    const EPolicyNotOwned: u64       = 3;
    const EAlreadyActive: u64        = 4;
    const EWrongPolicy: u64          = 5;
    const EWalletAlreadyActive: u64  = 6;

    // =========================================================================
    // Config — shared, one per deployment
    // =========================================================================

    public struct Config has key {
        id: UID,
        admin: address,
        authorized_operator: address,
        /// One policy per wallet — same registry pattern as policy.move
        active_wallets: Table<address, ID>,
    }

    // =========================================================================
    // NotificationPolicy — shared, one per user
    // Passed to seal_approve. Mirrors Policy in policy.move.
    // =========================================================================

    public struct NotificationPolicy has key, store {
        id: UID,
        owner: address,
        active: bool,
        created_at: u64,
    }

    // =========================================================================
    // NotificationCredential — owned by user, lives in their wallet
    // Holds the Seal-encrypted Telegram handle. Never passed to seal_approve.
    // Mirrors AutomationCredential in policy.move.
    // =========================================================================

    public struct NotificationCredential has key, store {
        id: UID,
        owner: address,
        policy_id: ID,
        encrypted_blob: vector<u8>,
    }

    // =========================================================================
    // Events
    // =========================================================================

    public struct NotificationActivated has copy, drop {
        policy_id: ID,
        credential_id: ID,
        owner: address,
        created_at: u64,
    }

    public struct NotificationDeactivated has copy, drop {
        policy_id: ID,
        owner: address,
    }

    public struct NotificationReactivated has copy, drop {
        policy_id: ID,
        owner: address,
    }

    public struct NotificationCredentialUpdated has copy, drop {
        policy_id: ID,
        credential_id: ID,
        owner: address,
    }

    public struct NotificationCancelled has copy, drop {
        policy_id: ID,
        owner: address,
        cancelled_at: u64,
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

    /// Activate — creates NotificationPolicy (shared) + NotificationCredential (owned).
    /// One policy per wallet enforced via Config.active_wallets.
    /// encrypted_blob = SealClient.encrypt(<telegram_handle>) from the frontend.
    #[allow(lint(self_transfer))]
    public fun activate_notification(
        config: &mut Config,
        encrypted_blob: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(
            !table::contains(&config.active_wallets, ctx.sender()),
            EWalletAlreadyActive
        );

        let now = clock::timestamp_ms(clock);

        let policy = NotificationPolicy {
            id: object::new(ctx),
            owner: ctx.sender(),
            active: true,
            created_at: now,
        };
        let policy_id = object::id(&policy);

        let credential = NotificationCredential {
            id: object::new(ctx),
            owner: ctx.sender(),
            policy_id,
            encrypted_blob,
        };
        let credential_id = object::id(&credential);

        table::add(&mut config.active_wallets, ctx.sender(), policy_id);

        event::emit(NotificationActivated {
            policy_id,
            credential_id,
            owner: ctx.sender(),
            created_at: now,
        });

        // Policy shared — bot and Seal can reference it in PTBs
        transfer::share_object(policy);
        // Credential owned — lives in user wallet, never in PTBs
        transfer::transfer(credential, ctx.sender());
    }

    /// Pause notifications. Only owner can deactivate.
    public fun deactivate_notification(
        policy: &mut NotificationPolicy,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == policy.owner, EPolicyNotOwned);
        policy.active = false;
        event::emit(NotificationDeactivated {
            policy_id: object::id(policy),
            owner: policy.owner,
        });
    }

    /// Resume notifications after a pause.
    public fun reactivate_notification(
        policy: &mut NotificationPolicy,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == policy.owner, EPolicyNotOwned);
        assert!(!policy.active, EAlreadyActive);
        policy.active = true;
        event::emit(NotificationReactivated {
            policy_id: object::id(policy),
            owner: policy.owner,
        });
    }

    /// Replace the encrypted blob — user changed Telegram handle or wants to re-encrypt.
    public fun update_notification_credential(
        policy: &NotificationPolicy,
        credential: &mut NotificationCredential,
        new_encrypted_blob: vector<u8>,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == policy.owner, EPolicyNotOwned);
        assert!(credential.policy_id == object::id(policy), EWrongPolicy);
        credential.encrypted_blob = new_encrypted_blob;
        event::emit(NotificationCredentialUpdated {
            policy_id: object::id(policy),
            credential_id: object::id(credential),
            owner: policy.owner,
        });
    }

    /// Fully cancel — deactivate policy, delete credential, remove from registry.
    /// One transaction, emits NotificationCancelled so backend removes wallet immediately.
    public fun deactivate_and_delete(
        config: &mut Config,
        policy: &mut NotificationPolicy,
        credential: NotificationCredential,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == policy.owner, EPolicyNotOwned);
        assert!(credential.policy_id == object::id(policy), EWrongPolicy);

        let now = clock::timestamp_ms(clock);
        let policy_id = object::id(policy);

        policy.active = false;

        if (table::contains(&config.active_wallets, ctx.sender())) {
            table::remove(&mut config.active_wallets, ctx.sender());
        };

        let NotificationCredential { id, owner: _, policy_id: _, encrypted_blob: _ } = credential;
        object::delete(id);

        event::emit(NotificationCancelled {
            policy_id,
            owner: ctx.sender(),
            cancelled_at: now,
        });
    }

    // =========================================================================
    // Seal integration
    // =========================================================================

    /// Evaluated by Seal key servers via dry_run_transaction_block.
    /// Identical pattern to policy.move::seal_approve.
    /// Config + NotificationPolicy are both shared — bot references both
    /// as sharedObjectRef, exactly as in the working decrypt.js.
    entry fun seal_approve(
        id: vector<u8>,
        config: &Config,
        policy: &NotificationPolicy,
        ctx: &TxContext,
    ) {
        let _ = id;
        assert!(ctx.sender() == config.authorized_operator, ENotAuthorized);
        assert!(policy.active, EPolicyInactive);
    }

    // =========================================================================
    // Read-only accessors
    // =========================================================================

    public fun is_active(policy: &NotificationPolicy): bool { policy.active }
    public fun owner(policy: &NotificationPolicy): address { policy.owner }
    public fun created_at(policy: &NotificationPolicy): u64 { policy.created_at }
    public fun policy_id(credential: &NotificationCredential): ID { credential.policy_id }
    public fun encrypted_blob(credential: &NotificationCredential): vector<u8> { credential.encrypted_blob }
    public fun authorized_operator(config: &Config): address { config.authorized_operator }
    public fun admin(config: &Config): address { config.admin }
    public fun has_active_policy(config: &Config, wallet: address): bool {
        table::contains(&config.active_wallets, wallet)
    }
}
