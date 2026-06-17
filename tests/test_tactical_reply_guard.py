from diplomacy import Game

from ai_diplomacy.utils import gather_possible_orders
from human_play import HumanGameSession


def _guard_fixture():
    game = Game()
    game.clear_units()
    game.set_units("FRANCE", ["F NTH"])
    game.set_units("GERMANY", ["F HEL", "A SWE"])
    game.set_units("ENGLAND", ["F NWY"])
    game.set_centers("GERMANY", ["BER", "KIE", "MUN", "HOL", "DEN", "SWE"])

    session = HumanGameSession.__new__(HumanGameSession)
    session.game = game
    session.human_power = "FRANCE"
    return session, gather_possible_orders(game, "GERMANY"), game.get_state()


def test_support_claim_parser_handles_multiple_named_units():
    session, _, _ = _guard_fixture()

    claims = session._support_claims_from_reply(
        "I can support your NTH fleet into NWY with F HEL and A SWE."
    )

    assert [(claim["support_type"], claim["support_loc"]) for claim in claims] == [
        ("F", "HEL"),
        ("A", "SWE"),
    ]


def test_invalid_support_unit_is_not_hidden_by_valid_support_unit():
    session, possible_orders, board_state = _guard_fixture()

    conflict = session._reply_tactical_legality_conflict(
        "I can't support you into HOL. How about I support your NTH fleet into NWY with F HEL and A SWE?",
        "GERMANY",
        possible_orders,
        board_state,
    )

    assert conflict
    assert "F HEL S F NTH - NWY" in conflict


def test_support_into_own_center_is_rejected_unless_ceded():
    session, possible_orders, board_state = _guard_fixture()

    conflict = session._reply_tactical_legality_conflict(
        "I can support your NTH fleet into HOL.",
        "GERMANY",
        possible_orders,
        board_state,
    )

    assert conflict
    assert "HOL is one of GERMANY's own supply centers" in conflict


def test_negative_support_statement_does_not_trigger_self_center_guard():
    session, possible_orders, board_state = _guard_fixture()

    conflict = session._reply_tactical_legality_conflict(
        "I can't support you into HOL - I hold it.",
        "GERMANY",
        possible_orders,
        board_state,
    )

    assert conflict is None


def test_valid_named_support_unit_is_allowed():
    session, possible_orders, board_state = _guard_fixture()

    conflict = session._reply_tactical_legality_conflict(
        "I can support your NTH fleet into NWY with A SWE.",
        "GERMANY",
        possible_orders,
        board_state,
    )

    assert conflict is None


def test_false_negative_support_legality_claim_is_rejected():
    game = Game()
    game.clear_units()
    game.set_units("FRANCE", ["F ENG"])
    game.set_units("GERMANY", ["F HEL", "F HOL"])
    game.set_units("ENGLAND", ["F NTH"])

    session = HumanGameSession.__new__(HumanGameSession)
    session.game = game
    session.human_power = "FRANCE"

    conflict = session._reply_tactical_legality_conflict(
        "I can't support F ENG into NTH - it's not adjacent.",
        "GERMANY",
        gather_possible_orders(game, "GERMANY"),
        game.get_state(),
    )

    assert conflict
    assert "F ENG - NTH" in conflict
