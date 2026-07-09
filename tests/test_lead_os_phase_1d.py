from lead_os.agent_auth import AgentCredentialStore, AgentIdentity, ScopeDeniedError
from lead_os.outcomes import OutcomeRegistry, OutcomeType, build_scorecards
from lead_os.supervisor import ApprovalStatus, SupervisorLedger, requires_approval


def test_agent_store_resolves_hashed_key_and_scope():
    identity = AgentIdentity(
        agent_id="sales-agent-v1",
        agent_type="sales",
        display_name="Sales Agent",
        scopes=frozenset({"leads:read"}),
    )
    store = AgentCredentialStore()
    store.add_plaintext_key("dev-secret", identity)

    resolved = store.require_scope("dev-secret", "leads:read")

    assert resolved.agent_id == "sales-agent-v1"


def test_agent_store_denies_missing_scope():
    identity = AgentIdentity(
        agent_id="sales-agent-v1",
        agent_type="sales",
        display_name="Sales Agent",
        scopes=frozenset({"leads:read"}),
    )
    store = AgentCredentialStore()
    store.add_plaintext_key("dev-secret", identity)

    try:
        store.require_scope("dev-secret", "estimates:create_draft")
    except ScopeDeniedError as exc:
        assert exc.agent_id == "sales-agent-v1"
        assert exc.required_scope == "estimates:create_draft"
    else:
        raise AssertionError("missing scope should fail closed")


def test_customer_visible_custom_message_requires_approval():
    status = requires_approval(
        action_type="send_followup",
        is_customer_visible=True,
        uses_approved_template=False,
        confidence_score=0.91,
        risk_score=0.10,
    )

    assert status == ApprovalStatus.PENDING_APPROVAL


def test_low_confidence_estimate_requires_approval():
    status = requires_approval(
        action_type="draft_estimate",
        is_customer_visible=False,
        confidence_score=0.55,
        risk_score=0.10,
    )

    assert status == ApprovalStatus.PENDING_APPROVAL


def test_supervisor_queues_pending_approval_action():
    agent = AgentIdentity(
        agent_id="estimator-agent-v1",
        agent_type="estimator",
        display_name="Estimator Agent",
        scopes=frozenset({"estimates:create_draft"}),
    )
    ledger = SupervisorLedger()

    action = ledger.record_action(
        request_id="req-1",
        agent=agent,
        action_type="send_final_price",
        target_type="estimate",
        target_id="est_1",
        input_summary="Send final customer price",
        confidence_score=0.88,
        risk_score=0.20,
        approval_status=ApprovalStatus.PENDING_APPROVAL,
    )

    assert len(ledger.actions) == 1
    assert len(ledger.queue) == 1
    assert ledger.queue[0].agent_action_id == action.id
    assert "final price" in ledger.queue[0].reason.lower()


def test_outcomes_link_to_actions_and_scorecards():
    agent = AgentIdentity(
        agent_id="follow-up-agent-v1",
        agent_type="follow_up",
        display_name="Follow-Up Agent",
        scopes=frozenset({"messages:create_template_followup"}),
    )
    ledger = SupervisorLedger()
    action = ledger.record_action(
        request_id="req-2",
        agent=agent,
        action_type="send_template_followup",
        target_type="lead",
        target_id="lead_1",
        input_summary="Send approved follow-up template",
        confidence_score=0.90,
        risk_score=0.05,
        approval_status=ApprovalStatus.NOT_REQUIRED,
    )
    registry = OutcomeRegistry()
    outcome = registry.record_outcome(
        outcome_type=OutcomeType.LEAD_WON,
        lead_id="lead_1",
        revenue_cents=75000,
        margin_cents=30000,
    )
    registry.link_action(
        agent_action_id=action.id,
        outcome_id=outcome.id,
        influence_type="followed_up",
        weight=1.0,
    )

    scorecards = build_scorecards(ledger.actions, registry)

    card = scorecards["follow-up-agent-v1"]
    assert card.actions_attempted == 1
    assert card.actions_completed == 1
    assert card.wins_influenced == 1
    assert card.revenue_influenced_cents == 75000
    assert card.margin_influenced_cents == 30000
