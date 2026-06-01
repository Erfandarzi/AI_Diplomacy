"""Regression tests for nearest-uncontrolled-SC discovery.

Covers the fix for the bug where `get_nearest_uncontrolled_scs` skipped every
supply center within one move (`if distance <= 1: continue`), so units could
only "see" SCs that were two or more moves away. The function must now report
distance-0 (the unit is sitting on an uncontrolled SC; holding captures it) and
distance-1 (adjacent) centers as well.
"""

from diplomacy import Game

from ai_diplomacy.possible_order_context import (
    build_diplomacy_graph,
    get_nearest_uncontrolled_scs,
    generate_rich_order_context_xml,
)

UNIT_TYPE = {"A": "ARMY", "F": "FLEET"}


def _context(game):
    return game.map, game.get_state(), build_diplomacy_graph(game.map)


def test_adjacent_sc_is_reported_at_distance_one():
    """At game start, Italy's army in Venice is adjacent to Trieste (Austrian).

    The old code dropped distance<=1, so this SC was invisible to the agent.
    """
    game = Game()
    gmap, board, graph = _context(game)

    results = get_nearest_uncontrolled_scs(gmap, board, graph, "ITALY", "VEN", "ARMY", n=5)
    by_province = {tag.split()[0]: dist for tag, dist, _ in results}

    assert "TRI" in by_province, f"Adjacent SC TRI missing from {by_province}"
    assert by_province["TRI"] == 1


def test_every_starting_power_sees_a_distance_one_sc():
    """Several powers begin adjacent to neutral/enemy SCs (e.g. FRA MAR->SPA,
    TUR CON->BUL, GER KIE->DEN). None of these should be filtered out."""
    game = Game()
    gmap, board, graph = _context(game)

    distance_one_hits = 0
    for power_name, power in game.powers.items():
        for unit in power.units:  # e.g. "A PAR"
            symbol, loc = unit.split(" ")
            results = get_nearest_uncontrolled_scs(
                gmap, board, graph, power_name, loc, UNIT_TYPE[symbol], n=5
            )
            distance_one_hits += sum(1 for _, dist, _ in results if dist == 1)

    # Empirically there are 8 such cases on the standard map at S1901M.
    assert distance_one_hits >= 5, (
        f"Expected several distance-1 SCs at game start, found {distance_one_hits}"
    )


def test_unit_on_uncontrolled_sc_is_reported_at_distance_zero():
    """A fleet that moves onto a still-neutral SC should see it at distance 0,
    since holding there captures it in the next adjustment."""
    game = Game()
    game.set_orders("GERMANY", ["F KIE - DEN"])
    game.process()  # fleet now sits on Denmark; control flips only in the Fall

    gmap, board, graph = _context(game)
    results = get_nearest_uncontrolled_scs(gmap, board, graph, "GERMANY", "DEN", "FLEET", n=4)
    by_province = {tag.split()[0]: dist for tag, dist, _ in results}

    assert by_province.get("DEN") == 0, f"Expected DEN at distance 0, got {by_province}"


def test_distance_zero_renders_you_are_here_in_xml():
    """The XML context must special-case distance 0 with the capture hint
    instead of printing a degenerate path."""
    game = Game()
    game.set_orders("GERMANY", ["F KIE - DEN"])
    game.process()

    orderable = game.get_orderable_locations("GERMANY")
    all_orders = game.get_all_possible_orders()
    possible_orders = {loc: all_orders.get(loc, []) for loc in orderable}

    xml = generate_rich_order_context_xml(game, "GERMANY", possible_orders)

    assert "YOU ARE HERE, hold to capture!" in xml
    # The dist=0 entry must not be rendered as a normal path line.
    assert "dist=0, path=" not in xml
