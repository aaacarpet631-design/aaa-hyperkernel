import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from lead_os import AgentIdentity, LeadOsSQLiteStore
from lead_os.outcomes import OutcomeRegistry, OutcomeType, build_scorecards
from lead_os.supervisor import ApprovalStatus, SupervisorLedger


def test_sqlite_store_persists_agent_credentials(tmp_path):
    db_path = tmp_path / "lead_os.db"
    store = LeadOsSQLiteStore(db_path)
    identity = AgentIdentity(
        agent_id="sales-agent-v1",
        agent_type="sales",
        display_name="Sales Agent",
        scopes=frozenset({"leads:read", "tasks:create"}),
    )

    store.save_credential(raw_key="dev-sales-key", identity=identity)
    hydrated = store.load_credential_store()
    resolved = hydrated.require_scope("dev-sales-key", "tasks:create")

    assert resolved.agent_id == "sales-agent-v1"
    assert resolved.has_scope("leads:read")
    store.close()


def test_sqlite_store_persists_supervisor_actions_and_queue(tmp_path):
    db_path = tmp_path / "lead_os.db"
    store = LeadOsSQLiteStore(db_path)
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
        confidence_score=0.82,
        risk_score=0.20,
        approval_status=ApprovalStatus.PENDING_APPROVAL,
    )

    store.save_supervisor_snapshot(ledger.actions, ledger.queue)
    loaded_actions = store.load_agent_actions()
    loaded_queue = store.load_supervisor_queue(status="open")

    assert loaded_actions[0].id == action.id
    assert loaded_actions[0].approval_status == ApprovalStatus.PENDING_APPROVAL
    assert loaded_queue[0].agent_action_id == action.id
    assert loaded_queue[0].status == "open"
    store.close()


def test_sqlite_store_persists_outcomes_and_scorecards(tmp_path):
    db_path = tmp_path / "lead_os.db"
    store = LeadOsSQLiteStore(db_path)
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
        input_summary="Send template follow-up",
        confidence_score=0.90,
        risk_score=0.05,
        approval_status=ApprovalStatus.NOT_REQUIRED,
    )
    registry = OutcomeRegistry()
    outcome = registry.record_outcome(
        outcome_type=OutcomeType.LEAD_WON,
        lead_id="lead_1",
        revenue_cents=95000,
        margin_cents=38000,
    )
    registry.link_action(
        agent_action_id=action.id,
        outcome_id=outcome.id,
        influence_type="followed_up",
    )

    store.save_supervisor_snapshot(ledger.actions, ledger.queue)
    store.save_outcome_registry(registry)
    loaded_registry = store.load_outcome_registry()
    loaded_actions = store.load_agent_actions()
    scorecards = build_scorecards(loaded_actions, loaded_registry)

    card = scorecards["follow-up-agent-v1"]
    assert card.wins_influenced == 1
    assert card.revenue_influenced_cents == 95000
    assert card.margin_influenced_cents == 38000
    store.close()
