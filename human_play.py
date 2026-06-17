import argparse
import asyncio
import json
import logging
import os
import re
import time
from argparse import Namespace
from collections import defaultdict
from difflib import SequenceMatcher
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import RLock
from typing import Any
from urllib.parse import parse_qs, urlparse

import dotenv

ROOT = Path(__file__).resolve().parent
dotenv.load_dotenv(ROOT / ".env")

from diplomacy import Game
from diplomacy.engine.message import GLOBAL, Message

from ai_diplomacy.agent import ALL_POWERS, DiplomacyAgent
from ai_diplomacy.clients import MockModelClient, load_model_client
from ai_diplomacy.game_history import GameHistory
from ai_diplomacy.game_logic import load_game_state, save_game_state
from ai_diplomacy.negotiations import conduct_negotiations
from ai_diplomacy.prompt_constructor import build_context_prompt
from ai_diplomacy.utils import gather_possible_orders, log_llm_response_async, parse_prompts_dir_arg, run_llm_and_log
from config import config

STATIC_ROOT = ROOT / "human_play_static"
STANDARD_SVG = ROOT / "diplomacy" / "maps" / "svg" / "standard.svg"
STANDARD_COORDS = ROOT / "diplomacy" / "maps" / "standard_coords.json"
POWERS = ["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"]
MODEL_STATS_TEMPLATE = {"conversation_errors": 0, "order_decoding_errors": 0}
DEFAULT_OPENROUTER_MODEL = "openrouter:deepseek/deepseek-v4-flash"
DEFAULT_CHAT_MAX_TOKENS = 360
DEFAULT_ORDER_MAX_TOKENS = 900
VISUAL_PROVINCE_ALIASES = {
    "MID": "MAO",
    "NAT": "NAO",
    "NRG": "NWG",
    "GOL": "LYO",
    "TYN": "TYS",
}
HOME_CENTER_CODES = {
    "AUSTRIA": {"BUD", "TRI", "VIE"},
    "ENGLAND": {"EDI", "LON", "LVP"},
    "FRANCE": {"BRE", "MAR", "PAR"},
    "GERMANY": {"BER", "KIE", "MUN"},
    "ITALY": {"NAP", "ROM", "VEN"},
    "RUSSIA": {"MOS", "SEV", "STP", "WAR"},
    "TURKEY": {"ANK", "CON", "SMY"},
}
RELATIONSHIP_RANK = {
    "Ally": 0,
    "Friendly": 1,
    "Neutral": 2,
    "Unfriendly": 3,
    "Enemy": 4,
}
TACTICAL_COMMITMENT_KEYWORDS = (
    "ally",
    "alliance",
    "avoid",
    "bounce",
    "convoy",
    "coordinate",
    "cooperate",
    "deal",
    "demilitar",
    "dmz",
    "help",
    "hold",
    "move",
    "promise",
    "support",
    "trust",
    "work together",
)
HOSTILE_MESSAGE_KEYWORDS = (
    "attack you",
    "betray",
    "enemy",
    "fight",
    "no friend",
    "not friend",
    "stab",
    "war",
)
ENGINE_TYPE_NAMES = {
    "WATER": "sea",
    "LAND": "land",
    "COAST": "land",
    "SHUT": "impassable",
}

logger = logging.getLogger("human_play")


def _read_unit_coordinates() -> dict[str, dict[str, float]]:
    svg = STANDARD_SVG.read_text(encoding="utf-8")
    pattern = re.compile(
        r'<jdipNS:PROVINCE name="([^"]+)">\s*<jdipNS:UNIT x="([\d.]+)" y="([\d.]+)"',
        re.MULTILINE,
    )
    coordinates = {
        name.upper(): {"x": float(x), "y": float(y)}
        for name, x, y in pattern.findall(svg)
    }
    for key, coord in list(coordinates.items()):
        coordinates.setdefault(key.replace("-", "/"), coord)
        coordinates.setdefault(key.replace("-", "_"), coord)
        coordinates.setdefault(key.replace("/", "-"), coord)
        coordinates.setdefault(key.replace("/", "_"), coord)
    for visual_code, engine_code in VISUAL_PROVINCE_ALIASES.items():
        if visual_code in coordinates:
            coordinates.setdefault(engine_code, coordinates[visual_code])
        if engine_code in coordinates:
            coordinates.setdefault(visual_code, coordinates[engine_code])
    return coordinates


UNIT_COORDINATES = _read_unit_coordinates()


def _read_map_metadata() -> dict[str, Any]:
    with STANDARD_COORDS.open("r", encoding="utf-8") as file:
        data = json.load(file)
    provinces = data.get("provinces", {})
    engine_map = Game().map
    engine_names = {code: name.title() for name, code in engine_map.loc_name.items()}
    for loc in engine_map.locs:
        base = loc.replace("/", "_").split("_", 1)[0]
        if base in provinces:
            continue
        provinces[base] = {
            "name": engine_names.get(loc, engine_names.get(base, base)),
            "type": ENGINE_TYPE_NAMES.get(engine_map.loc_type.get(base), "land"),
        }
    return {
        "provinces": provinces,
        "provinceNames": {code: meta.get("name", code) for code, meta in provinces.items()},
        "visualProvinceAliases": VISUAL_PROVINCE_ALIASES,
    }


MAP_METADATA = _read_map_metadata()
KNOWN_PROVINCE_CODES = set(MAP_METADATA["provinceNames"])


class HumanGameSession:
    def __init__(self, args: Namespace):
        self.args = args
        self.lock = RLock()
        self.human_power = args.human_power.upper()
        self.run_dir = self._make_run_dir(args.run_dir)
        self.game_file_path = self.run_dir / "lmvsgame.json"
        self.session_state_path = self.run_dir / "human_session.json"
        self.llm_log_file_path = self.run_dir / "llm_responses.csv"
        self.model_error_stats: dict[str, dict[str, int]] = defaultdict(lambda: MODEL_STATS_TEMPLATE.copy())
        self.pending_human_orders: dict[str, list[str]] = {}
        self.status = "Ready."
        self.busy = False
        is_resume = args.resume and self.game_file_path.exists()
        if is_resume and not args.models and not args.mock_agents:
            default_model = self._default_model_id(allow_missing=False)
            if default_model:
                args.models = default_model
        if is_resume:
            self.game, self.agents, self.game_history, _ = load_game_state(
                str(self.run_dir),
                "lmvsgame.json",
                args,
                args.resume_from_phase,
            )
            self.status = f"Resumed {self.game.get_current_phase()} from {self.run_dir}."
        else:
            self.game = Game()
            self.game_history = GameHistory()
            self.agents = self._create_agents()
        self._load_session_state()
        self._ensure_phase()
        self._ensure_agent_strategy_profiles()
        self._refresh_visible_relationship_profiles()
        if not is_resume:
            self._add_system_message(
                f"Local human game created. You are {self.human_power}. "
                f"AI powers: {', '.join(self.agents.keys())}."
            )

    def _make_run_dir(self, raw_run_dir: str) -> Path:
        if raw_run_dir:
            run_dir = Path(raw_run_dir)
        else:
            run_dir = ROOT / "results" / f"human_{time.strftime('%Y%m%d_%H%M%S')}"
        run_dir.mkdir(parents=True, exist_ok=True)
        return run_dir

    def _load_session_state(self) -> None:
        if not self.session_state_path.exists():
            return
        try:
            with self.session_state_path.open("r", encoding="utf-8") as file:
                payload = json.load(file)
            pending = payload.get("pending_human_orders", {})
            if isinstance(pending, dict):
                self.pending_human_orders = {
                    str(phase): [str(order) for order in orders]
                    for phase, orders in pending.items()
                    if isinstance(orders, list)
                }
        except Exception as exc:
            logger.warning("Could not load human session state: %s", exc, exc_info=True)

    def _save_session_state(self) -> None:
        payload = {"pending_human_orders": self.pending_human_orders}
        with self.session_state_path.open("w", encoding="utf-8") as file:
            json.dump(payload, file, indent=2)

    async def _save_checkpoint(self, phase_name: str | None = None) -> None:
        await save_game_state(
            self.game,
            self.agents,
            self.game_history,
            str(self.game_file_path),
            self.args,
            phase_name or self.game.get_current_phase(),
        )

    def _create_agents(self) -> dict[str, DiplomacyAgent]:
        model_map = self._model_map()
        agents: dict[str, DiplomacyAgent] = {}
        for power_name in POWERS:
            if power_name == self.human_power:
                continue

            prompts_dir = self._prompts_dir_for_power(power_name)
            model_id = model_map[power_name]
            if self.args.mock_agents or model_id.startswith("mock:"):
                client = MockModelClient(model_id, prompts_dir=prompts_dir)
            else:
                client = load_model_client(model_id, prompts_dir=prompts_dir)
                client.max_tokens = self.args.max_tokens

            goals = [
                "Protect home supply centers.",
                "Negotiate for one stable neighbor relationship.",
                "Expand toward the nearest realistic neutral supply center.",
                "Track reputation by comparing messages, promises, tone, and actual orders.",
            ]
            relationships = {p: "Neutral" for p in POWERS if p != power_name}
            agent = DiplomacyAgent(
                power_name=power_name,
                client=client,
                initial_goals=goals,
                initial_relationships=relationships,
                prompts_dir=prompts_dir,
            )
            agent.add_diary_entry(self._initial_strategy_profile(power_name), self.game.get_current_phase())
            agents[power_name] = agent
        self.game.power_model_map = {p: a.client.model_name for p, a in agents.items()}
        return agents

    def _initial_strategy_profile(self, power_name: str) -> str:
        profiles = {
            "AUSTRIA": (
                "Strategic doctrine: survive by preventing an Italy/Russia/Turkey squeeze. "
                "Prefer one sincere alliance and one ambiguous relationship. Watch for Balkan promises that do not match orders. "
                "Project calm, but punish early encirclement."
            ),
            "ENGLAND": (
                "Strategic doctrine: naval leverage first. Present as reliable while keeping France and Germany uncertain enough "
                "that neither can safely ignore you. Track Channel/North Sea commitments and exploit exposed coastlines."
            ),
            "FRANCE": (
                "Strategic doctrine: secure Iberia, avoid a two-front western war, and decide whether England or Germany is the better "
                "temporary partner. Sound reasonable, but keep options open for a timely stab."
            ),
            "GERMANY": (
                "Strategic doctrine: broker the center. Encourage England, France, and Russia to spend force away from you. "
                "Use Belgium/Holland/Denmark diplomacy to measure trust and switch partners if the board opens."
            ),
            "ITALY": (
                "Strategic doctrine: avoid passive irrelevance. Keep Austria calm unless a clear attack is profitable, probe France/Turkey, "
                "and use delayed timing as leverage. Deception is acceptable if it creates the only realistic growth path."
            ),
            "RUSSIA": (
                "Strategic doctrine: manage separate northern and southern bargains without triggering a grand coalition. "
                "You may overpromise, but track when reputational cost becomes more dangerous than tactical gain."
            ),
            "TURKEY": (
                "Strategic doctrine: build a secure corner, then break out. Treat Black Sea/Balkan signals as critical. "
                "Use patience, selective trust, and quiet misdirection when it protects the breakout."
            ),
        }
        return profiles.get(power_name, "Strategic doctrine: pursue supply-center growth while tracking trust, risk, and reputation.")

    def connect_openrouter(self, api_key: str, model_id: str) -> dict[str, Any]:
        dotenv.load_dotenv(ROOT / ".env")
        api_key = api_key.strip() or os.environ.get("OPENROUTER_API_KEY", "").strip()
        if not api_key:
            raise ValueError("OPENROUTER_API_KEY is not configured on the server.")
        model_id = (model_id or DEFAULT_OPENROUTER_MODEL).strip()
        if not model_id.startswith("openrouter:"):
            model_id = f"openrouter:{model_id}"
        with self.lock:
            os.environ["OPENROUTER_API_KEY"] = api_key
            self.args.mock_agents = False
            self.args.models = model_id
            for power_name, agent in self.agents.items():
                prompts_dir = self._prompts_dir_for_power(power_name)
                client = load_model_client(model_id, prompts_dir=prompts_dir)
                client.max_tokens = self.args.max_tokens
                agent.client = client
            self.game.power_model_map = {p: a.client.model_name for p, a in self.agents.items()}
            self.status = f"Connected OpenRouter agents with {model_id.replace('openrouter:', '')}."
            return self.snapshot()

    def _model_map(self) -> dict[str, str]:
        ai_powers = [p for p in POWERS if p != self.human_power]
        raw = self.args.models.strip()
        if not raw:
            default_model = self._default_model_id(allow_missing=self.args.mock_agents)
            if not default_model:
                raise RuntimeError(
                    "No LLM API key is configured. Set OPENROUTER_API_KEY in .env or the shell, "
                    "or pass --mock-agents only for development smoke tests."
                )
            return {p: default_model for p in ai_powers}

        models = [m.strip() for m in raw.split(",") if m.strip()]
        if len(models) == 1:
            return {p: models[0] for p in ai_powers}
        if len(models) == len(ai_powers):
            return dict(zip(ai_powers, models))
        if len(models) == len(POWERS):
            return {p: model for p, model in zip(POWERS, models) if p != self.human_power}
        raise ValueError(f"--models expects 1, {len(ai_powers)}, or 7 model ids; got {len(models)}")

    def _default_model_id(self, allow_missing: bool = False) -> str:
        if os.environ.get("OPENROUTER_API_KEY"):
            return DEFAULT_OPENROUTER_MODEL
        if os.environ.get("OPENAI_API_KEY"):
            return "openai:gpt-4o"
        return "mock:local" if allow_missing else ""

    def _prompts_dir_for_power(self, power_name: str) -> str | None:
        if getattr(self.args, "prompts_dir_map", None):
            path = self.args.prompts_dir_map.get(power_name)
            return str(path) if path else self.args.prompts_dir
        return self.args.prompts_dir

    def _ensure_phase(self) -> None:
        current_phase = self.game.get_current_phase()
        if not self.game_history.phases or self.game_history.phases[-1].name != current_phase:
            self.game_history.add_phase(current_phase)

    def _ensure_agent_strategy_profiles(self) -> None:
        phase = self.game.get_current_phase()
        reputation_goal = "Track reputation by comparing messages, promises, tone, and actual orders."
        for power_name, agent in self.agents.items():
            if reputation_goal not in agent.goals:
                agent.goals.append(reputation_goal)
            diary_text = "\n".join(str(entry) for entry in getattr(agent, "full_private_diary", []))
            if "Strategic doctrine:" not in diary_text:
                agent.add_diary_entry(self._initial_strategy_profile(power_name), phase)

    def _add_system_message(self, content: str) -> None:
        self._ensure_phase()
        self.game_history.add_message(self.game.get_current_phase(), "SYSTEM", GLOBAL, content)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            state = self.game.get_state()
            current_phase = self.game.get_current_phase()
            self._refresh_visible_relationship_profiles(state, current_phase)
            possible_orders = self._possible_orders_for(self.human_power)
            pending_human_orders = self.pending_human_orders.get(current_phase, [])
            if not possible_orders:
                pending_human_orders = []
            return {
                "humanPower": self.human_power,
                "powers": POWERS,
                "phase": current_phase,
                "shortPhase": self.game.current_short_phase,
                "phaseType": self.game.phase_type,
                "isGameDone": self.game.is_game_done,
                "winner": self._winner(),
                "busy": self.busy,
                "status": self.status,
                "aiStatus": self._ai_status(),
                "runDir": str(self.run_dir),
                "savedGamePath": str(self.game_file_path),
                "units": state.get("units", {}),
                "unitViews": self._unit_views(state),
                "centers": state.get("centers", {}),
                "centerOwners": self._center_owners(state),
                "builds": state.get("builds", {}),
                "orderableLocations": list(possible_orders.keys()),
                "possibleOrders": possible_orders,
                "pendingHumanOrders": pending_human_orders,
                "messages": self._visible_messages(),
                "lastPhase": self._last_phase_summary(),
                "phaseHistory": self._phase_history(),
                "agents": self._agent_summary(),
                "unitCoordinates": UNIT_COORDINATES,
                "provinceNames": MAP_METADATA["provinceNames"],
                "provinces": MAP_METADATA["provinces"],
                "visualProvinceAliases": MAP_METADATA["visualProvinceAliases"],
                "mapViewBox": {"width": 1835, "height": 1360},
            }

    def _winner(self) -> str | None:
        for power_name, power in self.game.powers.items():
            if len(power.centers) >= 18:
                return power_name
        return None

    def _ai_status(self) -> dict[str, Any]:
        model_names = [agent.client.model_name for agent in self.agents.values()]
        primary_model = model_names[0] if model_names else ""
        if self.args.mock_agents or any(model.startswith("mock:") for model in model_names):
            return {
                "mode": "mock",
                "label": "Mock AI",
                "detail": "No LLM API key is connected.",
                "real": False,
            }
        uses_openrouter = (
            "openrouter:" in getattr(self.args, "models", "")
            or any(agent.client.__class__.__name__ == "OpenRouterClient" for agent in self.agents.values())
        )
        if uses_openrouter:
            label = "DeepSeek Flash" if "deepseek-v4-flash" in primary_model else "OpenRouter"
            return {
                "mode": "openrouter",
                "label": label,
                "detail": f"Real LLM agents are connected with {primary_model}.",
                "real": True,
            }
        return {
            "mode": "llm",
            "label": "LLM",
            "detail": "Real LLM agents are connected.",
            "real": True,
        }

    def _require_real_llm_agents(self) -> None:
        if not self._ai_status()["real"]:
            raise RuntimeError(
                "Real LLM agents are not connected. Set OPENROUTER_API_KEY and restart without --mock-agents."
            )

    def _cap_client_tokens(self, client, cap: int) -> int:
        previous = getattr(client, "max_tokens", 0)
        if cap > 0:
            client.max_tokens = min(previous, cap) if previous else cap
        return previous

    def _restore_client_tokens(self, client, previous: int) -> None:
        client.max_tokens = previous

    def _unit_views(self, state: dict[str, Any]) -> list[dict[str, Any]]:
        units = []
        for power_name, unit_list in state.get("units", {}).items():
            for raw_unit in unit_list:
                dislodged = raw_unit.startswith("*")
                unit = raw_unit[1:] if dislodged else raw_unit
                parts = unit.split()
                if len(parts) < 2:
                    continue
                kind = parts[0]
                loc = parts[1]
                coord_key = self._coord_key(loc)
                units.append(
                    {
                        "power": power_name,
                        "type": "Army" if kind == "A" else "Fleet",
                        "raw": raw_unit,
                        "location": loc,
                        "coordKey": coord_key,
                        "dislodged": dislodged,
                    }
                )
        return units

    def _center_owners(self, state: dict[str, Any]) -> dict[str, str]:
        owners = {}
        for power_name, centers in state.get("centers", {}).items():
            for center in centers:
                owners[center.split("/")[0].upper()] = power_name
        return owners

    def _coord_key(self, location: str) -> str:
        coast_key = location.replace("/", "_").upper()
        if coast_key in UNIT_COORDINATES:
            return coast_key
        return location.split("/")[0].upper()

    def _visible_messages(self) -> list[dict[str, str]]:
        visible = []
        real_ai = self._ai_status()["real"]
        for phase in self.game_history.phases:
            for msg in phase.messages:
                if msg.sender == "SYSTEM":
                    continue
                if not real_ai and msg.sender != self.human_power:
                    continue
                if msg.recipient == GLOBAL or msg.sender == self.human_power or msg.recipient == self.human_power:
                    visible.append(
                        {
                            "phase": phase.name,
                            "sender": msg.sender,
                            "recipient": msg.recipient,
                            "content": msg.content,
                        }
                    )
        return visible

    def _last_phase_summary(self) -> dict[str, Any] | None:
        history = self._phase_history()
        if not history:
            return None
        return history[-1]

    def _phase_history(self) -> list[dict[str, Any]]:
        saved_boards = self._saved_phase_boards()
        return [
            self._phase_summary_for(phase, saved_boards.get(phase.name, {}))
            for phase in self.game_history.phases
            if phase.orders_by_power or phase.submitted_orders_by_power
        ]

    def _phase_summary_for(self, phase, saved_boards: dict[str, Any] | None = None) -> dict[str, Any]:
        saved_boards = saved_boards or {}
        return {
            "name": phase.name,
            "orders": self._jsonable({p: list(v) for p, v in phase.orders_by_power.items()}),
            "submitted": self._jsonable({p: list(v) for p, v in phase.submitted_orders_by_power.items()}),
            "results": self._jsonable({p: list(v) for p, v in phase.results_by_power.items()}),
            "boardBefore": saved_boards.get("before"),
            "boardAfter": saved_boards.get("after"),
        }

    def _saved_phase_boards(self) -> dict[str, dict[str, Any]]:
        if not self.game_file_path.exists():
            return {}
        try:
            with self.game_file_path.open("r", encoding="utf-8") as file:
                payload = json.load(file)
        except Exception as exc:
            logger.debug("Could not load saved phase boards: %s", exc)
            return {}

        phases = payload.get("phases", [])
        boards: dict[str, dict[str, Any]] = {}
        for index, phase_block in enumerate(phases):
            phase_name = phase_block.get("name")
            if not phase_name:
                continue
            next_phase = phases[index + 1] if index + 1 < len(phases) else None
            boards[phase_name] = {
                "before": self._board_snapshot_from_state(phase_block.get("state"), phase_name),
                "after": self._board_snapshot_from_state(
                    next_phase.get("state") if isinstance(next_phase, dict) else None,
                    next_phase.get("name") if isinstance(next_phase, dict) else "",
                ),
            }
        return boards

    def _board_snapshot_from_state(self, state: Any, phase_name: str) -> dict[str, Any] | None:
        if not isinstance(state, dict):
            return None
        return {
            "phase": phase_name,
            "units": state.get("units", {}),
            "unitViews": self._unit_views(state),
            "centers": state.get("centers", {}),
            "centerOwners": self._center_owners(state),
        }

    def _jsonable(self, value: Any) -> Any:
        if isinstance(value, dict):
            return {str(k): self._jsonable(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [self._jsonable(v) for v in value]
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        return str(value)

    def _agent_board_fact_brief(
        self,
        power_name: str,
        board_state: dict[str, Any],
        possible_orders: dict[str, list[str]],
    ) -> str:
        phase_kind = {
            "M": "movement",
            "R": "retreat",
            "A": "adjustment",
        }.get(self.game.phase_type, self.game.phase_type)
        lines = [
            f"Current phase: {self.game.get_current_phase()} ({phase_kind}).",
            f"You are {power_name}. The human player is {self.human_power}.",
        ]

        units = board_state.get("units", {}) if isinstance(board_state, dict) else {}
        lines.append("Current units:")
        for power in POWERS:
            lines.append(f"- {power}: {self._brief_items(units.get(power), max_items=14)}")

        centers = board_state.get("centers", {}) if isinstance(board_state, dict) else {}
        lines.append("Current supply centers:")
        for power in POWERS:
            owned = centers.get(power)
            count = len(owned) if isinstance(owned, list) else 0
            lines.append(f"- {power} ({count}): {self._brief_items(owned, max_items=14)}")

        last_phase = self._last_phase_summary()
        if last_phase:
            lines.append(f"Most recent completed order phase: {last_phase.get('name', 'unknown')}.")
            submitted = last_phase.get("submitted") or last_phase.get("orders") or {}
            if isinstance(submitted, dict) and submitted:
                lines.append("Last submitted orders:")
                for power in POWERS:
                    orders = submitted.get(power)
                    if orders:
                        lines.append(f"- {power}: {self._brief_items(orders, max_items=10, separator='; ')}")

            results = last_phase.get("results") or {}
            if isinstance(results, dict) and results:
                lines.append("Last adjudication notes:")
                for unit, result in list(results.items())[:18]:
                    note = self._flatten_brief_result(result)
                    if note:
                        lines.append(f"- {unit}: {note}")

        if not any(possible_orders.values()):
            lines.append(f"{power_name} has no legal orders needed this phase.")
        lines.append(
            "Support legality reminder: a unit can support only into a province that unit could enter itself; "
            "adjacency to the attacking unit is not enough."
        )
        return "\n".join(lines)

    def _brief_items(self, items: Any, max_items: int = 12, separator: str = ", ") -> str:
        if not items:
            return "none"
        if isinstance(items, str):
            values = [items]
        elif isinstance(items, (list, tuple, set)):
            values = [str(item) for item in items]
        else:
            values = [str(items)]
        shown = values[:max_items]
        extra = f"{separator}+{len(values) - max_items} more" if len(values) > max_items else ""
        return separator.join(shown) + extra

    def _flatten_brief_result(self, result: Any) -> str:
        if result is None:
            return ""
        if isinstance(result, (list, tuple, set)):
            parts = [self._flatten_brief_result(item) for item in result]
            return "; ".join(part for part in parts if part)
        if isinstance(result, dict):
            parts = [f"{key}: {self._flatten_brief_result(value)}" for key, value in result.items()]
            return "; ".join(part for part in parts if part)
        return str(result)

    def _base_code(self, value: str | None) -> str:
        return str(value or "").replace("*", "").upper().split()[0].split("/")[0]

    def _unit_location(self, unit: str) -> str:
        parts = str(unit or "").replace("*", "").split()
        return self._base_code(parts[1]) if len(parts) > 1 else ""

    def _unit_power_at(self, units: dict[str, list[str]], location: str | None) -> str | None:
        target = self._base_code(location)
        if not target:
            return None
        for power_name, unit_list in (units or {}).items():
            for unit in unit_list or []:
                if self._unit_location(unit) == target:
                    return power_name
        return None

    def _center_owner_at(self, centers: dict[str, list[str]], location: str | None) -> str | None:
        target = self._base_code(location)
        if not target:
            return None
        for power_name, center_list in (centers or {}).items():
            if any(self._base_code(center) == target for center in center_list or []):
                return power_name
        return None

    def _direct_move_destination(self, order: str) -> str | None:
        parts = str(order or "").strip().split()
        if "-" not in parts or "S" in parts or "C" in parts or "R" in parts:
            return None
        move_index = parts.index("-")
        return self._base_code(parts[move_index + 1]) if move_index + 1 < len(parts) else None

    def _support_order_parts(self, order: str) -> dict[str, str] | None:
        parts = str(order or "").strip().split()
        if "S" not in parts:
            return None
        support_index = parts.index("S")
        if support_index + 2 >= len(parts):
            return None
        move_index = parts.index("-") if "-" in parts[support_index:] else -1
        supported_loc = self._base_code(parts[support_index + 2])
        target_loc = self._base_code(parts[move_index + 1]) if move_index > -1 and move_index + 1 < len(parts) else supported_loc
        return {"supported_loc": supported_loc, "target_loc": target_loc}

    def _unit_at_location(self, units: dict[str, list[str]], location: str | None) -> tuple[str, str, str] | None:
        target = self._base_code(location)
        if not target:
            return None
        for power_name, unit_list in (units or {}).items():
            for unit in unit_list or []:
                parts = str(unit or "").replace("*", "").split()
                if len(parts) >= 2 and self._base_code(parts[1]) == target:
                    return power_name, parts[0].upper(), parts[1].upper()
        return None

    def _unit_for_power_at_location(
        self,
        units: dict[str, list[str]],
        power_name: str,
        location: str | None,
    ) -> tuple[str, str] | None:
        found = self._unit_at_location(units, location)
        if found and found[0] == power_name:
            return found[1], found[2]
        return None

    def _private_messages_with_power(self, other_power: str, limit: int = 10) -> list[tuple[str, str, str]]:
        messages: list[tuple[str, str, str]] = []
        for phase in self.game_history.phases:
            for msg in phase.messages:
                if (
                    (msg.sender == self.human_power and msg.recipient == other_power)
                    or (msg.sender == other_power and msg.recipient == self.human_power)
                ):
                    messages.append((phase.name, msg.sender, msg.content))
        return messages[-limit:]

    def _visible_messages_for_power(
        self,
        power_name: str,
        limit: int = 18,
        phase_limit: int = 5,
    ) -> list[tuple[str, str, str, str]]:
        messages: list[tuple[str, str, str, str]] = []
        for phase in self.game_history.phases[-phase_limit:]:
            for msg in phase.messages:
                if msg.recipient == GLOBAL or msg.sender == power_name or msg.recipient == power_name:
                    messages.append((phase.name, msg.sender, msg.recipient, msg.content))
        return messages[-limit:]

    def _text_province_codes(self, text: str) -> set[str]:
        normalized = re.sub(r"[^a-z0-9/ -]+", " ", str(text or "").lower())
        compact = re.sub(r"\s+", " ", normalized).strip()
        codes: set[str] = set()
        for code, name in MAP_METADATA["provinceNames"].items():
            base = self._base_code(code)
            if base and re.search(rf"\b{re.escape(base.lower())}\b", compact):
                codes.add(base)
            name_text = re.sub(r"[^a-z0-9/ -]+", " ", str(name or "").lower())
            name_text = re.sub(r"\s+", " ", name_text).strip()
            if name_text and re.search(rf"\b{re.escape(name_text)}\b", compact):
                codes.add(base)
        return codes

    def _order_province_codes(self, order: str) -> set[str]:
        codes: set[str] = set()
        for token in str(order or "").split():
            base = self._base_code(token)
            if base in KNOWN_PROVINCE_CODES:
                codes.add(base)
        return codes

    def _message_is_tactical(self, content: str) -> bool:
        lowered = str(content or "").lower()
        if any(keyword in lowered for keyword in TACTICAL_COMMITMENT_KEYWORDS):
            return True
        return len(self._text_province_codes(content)) >= 2

    def _matching_commitment_orders(
        self,
        possible_orders: dict[str, list[str]],
        messages: list[tuple[str, str, str, str]],
        limit: int = 10,
    ) -> list[str]:
        tactical_text = " ".join(content for _phase, _sender, _recipient, content in messages if self._message_is_tactical(content))
        mentioned_codes = self._text_province_codes(tactical_text)
        lowered = tactical_text.lower()
        if not mentioned_codes and not lowered:
            return []

        scored: list[tuple[int, str]] = []
        for orders in possible_orders.values():
            for order in orders or []:
                order_codes = self._order_province_codes(order)
                overlap = len(order_codes & mentioned_codes)
                if not overlap:
                    continue
                score = overlap * 2
                padded = f" {order} "
                if "support" in lowered and " S " in padded:
                    score += 3
                if "convoy" in lowered and " C " in padded:
                    score += 3
                if "move" in lowered and " - " in padded and " S " not in padded and " C " not in padded:
                    score += 2
                if "hold" in lowered and order.endswith(" H"):
                    score += 2
                if score >= 3:
                    scored.append((score, order))
        scored.sort(key=lambda item: (-item[0], item[1]))
        seen: set[str] = set()
        matches: list[str] = []
        for _score, order in scored:
            if order in seen:
                continue
            matches.append(order)
            seen.add(order)
            if len(matches) >= limit:
                break
        return matches

    def _tactical_commitment_brief(
        self,
        power_name: str,
        possible_orders: dict[str, list[str]] | None = None,
    ) -> str:
        possible_orders = possible_orders if possible_orders is not None else self._possible_orders_for(power_name)
        visible_messages = self._visible_messages_for_power(power_name)
        tactical_messages = [
            (phase, sender, recipient, content)
            for phase, sender, recipient, content in visible_messages
            if self._message_is_tactical(content)
        ][-8:]
        legal_matches = self._matching_commitment_orders(possible_orders, tactical_messages)

        lines = [
            "Concrete alliances matter here: promises, support requests, DMZs, and convoy plans are operational constraints, not vague sentiment.",
            "Only public press and this power's own private conversations are included; no hidden AI-to-AI chats are assumed.",
        ]
        if tactical_messages:
            lines.append("Recent visible tactical commitments and requests:")
            for phase, sender, recipient, content in tactical_messages:
                recipient_label = "GLOBAL" if recipient == GLOBAL else recipient
                provinces = sorted(self._text_province_codes(content))
                province_text = f" [provinces: {', '.join(provinces)}]" if provinces else ""
                excerpt = re.sub(r"\s+", " ", str(content)).strip()[:180]
                lines.append(f"- {phase} {sender} -> {recipient_label}: {excerpt}{province_text}")
        else:
            lines.append("Recent visible tactical commitments and requests: none detected.")

        if legal_matches:
            lines.append("Current legal orders that appear to satisfy or interact with those commitments:")
            for order in legal_matches:
                lines.append(f"- {order}")
        else:
            lines.append("Current legal order matches: none obvious from the text; still reason tactically from the board.")
        lines.append(
            "Decision rule: honor concrete allied support/convoy/DMZ commitments unless the board makes them illegal, suicidal, or already betrayed."
        )
        return "\n".join(lines)

    def _refresh_agent_tactical_contexts(self, board_state: dict[str, Any] | None = None, phase: str | None = None) -> None:
        phase = phase or self.game.get_current_phase()
        for power_name, agent in self.agents.items():
            if self.game.powers[power_name].is_eliminated():
                continue
            possible_orders = self._possible_orders_for(power_name)
            brief = self._tactical_commitment_brief(power_name, possible_orders)
            if "Recent visible tactical commitments and requests: none detected." in brief:
                continue
            self._add_diary_once(agent, phase, f"Active tactical commitments:\n{brief}")

    def _apply_message_relationship_update(self, sender: str, recipient: str, content: str, phase: str) -> None:
        if recipient == GLOBAL or sender == recipient:
            return
        lowered = str(content or "").lower()
        cooperative = any(keyword in lowered for keyword in TACTICAL_COMMITMENT_KEYWORDS)
        hostile = any(keyword in lowered for keyword in HOSTILE_MESSAGE_KEYWORDS)
        if recipient in self.agents and sender in POWERS:
            if hostile:
                self._relationship_floor(
                    recipient,
                    sender,
                    "Unfriendly",
                    f"{sender} sent hostile tactical message: {content[:140]}",
                    phase,
                )
            elif cooperative:
                self._relationship_floor(
                    recipient,
                    sender,
                    "Friendly",
                    f"{sender} sent cooperative tactical message: {content[:140]}",
                    phase,
                )

    def _refresh_message_relationship_profiles(self, phase_limit: int = 3) -> None:
        for phase in self.game_history.phases[-phase_limit:]:
            for msg in phase.messages:
                self._apply_message_relationship_update(msg.sender, msg.recipient, msg.content, phase.name)

    def _recent_submitted_orders(self, power_name: str, limit: int = 3) -> list[tuple[str, list[str]]]:
        rows: list[tuple[str, list[str]]] = []
        for phase in reversed(self.game_history.phases):
            orders = phase.submitted_orders_by_power.get(power_name) or phase.orders_by_power.get(power_name)
            if orders:
                rows.append((phase.name, [str(order) for order in orders]))
            if len(rows) >= limit:
                break
        return list(reversed(rows))

    def _relationship_floor(self, agent_power: str, other_power: str, status: str, reason: str, phase: str) -> None:
        if agent_power == other_power or agent_power not in self.agents:
            return
        agent = self.agents[agent_power]
        current = agent.relationships.get(other_power, "Neutral")
        current_rank = RELATIONSHIP_RANK.get(current, RELATIONSHIP_RANK["Neutral"])
        new_rank = RELATIONSHIP_RANK.get(status, current_rank)
        should_update = False
        if status in {"Enemy", "Unfriendly"}:
            should_update = new_rank > current_rank
        elif status in {"Friendly", "Ally"} and current not in {"Enemy", "Unfriendly"}:
            should_update = new_rank < current_rank
        if should_update:
            agent.relationships[other_power] = status
            self._add_diary_once(
                agent,
                phase,
                f"Relationship update: {other_power} -> {status}. {reason}",
            )

    def _add_diary_once(self, agent: DiplomacyAgent, phase: str, entry: str) -> None:
        formatted = f"[{phase}] {entry}"
        if formatted in getattr(agent, "full_private_diary", [])[-16:]:
            return
        agent.add_diary_entry(entry, phase)

    def _apply_order_based_relationship_updates(
        self,
        completed_phase: str,
        board_before: dict[str, Any],
        submitted_orders: dict[str, list[str]],
    ) -> None:
        units_before = board_before.get("units", {}) if isinstance(board_before, dict) else {}
        centers_before = board_before.get("centers", {}) if isinstance(board_before, dict) else {}
        for actor, orders in submitted_orders.items():
            for order in orders or []:
                destination = self._direct_move_destination(order)
                if destination:
                    defender = self._unit_power_at(units_before, destination) or self._center_owner_at(centers_before, destination)
                    for observer in self.agents:
                        if observer == actor:
                            continue
                        observer_centers = {self._base_code(center) for center in centers_before.get(observer, [])}
                        observer_home = HOME_CENTER_CODES.get(observer, set())
                        if destination in observer_home or destination in observer_centers or defender == observer:
                            severity = "Enemy" if destination in observer_home or destination in observer_centers else "Unfriendly"
                            self._relationship_floor(
                                observer,
                                actor,
                                severity,
                                f"{actor} ordered {order}, targeting {destination}.",
                                completed_phase,
                            )

                support = self._support_order_parts(order)
                if support:
                    supported_power = self._unit_power_at(units_before, support["supported_loc"])
                    target_power = (
                        self._unit_power_at(units_before, support["target_loc"])
                        or self._center_owner_at(centers_before, support["target_loc"])
                    )
                    if supported_power and supported_power != actor:
                        self._relationship_floor(
                            supported_power,
                            actor,
                            "Friendly",
                            f"{actor} ordered {order}, supporting {supported_power}.",
                            completed_phase,
                        )
                    if target_power and target_power not in {actor, supported_power}:
                        self._relationship_floor(
                            target_power,
                            actor,
                            "Unfriendly",
                            f"{actor} ordered {order}, pressuring {target_power}.",
                            completed_phase,
                        )

    def _apply_board_position_relationship_updates(self, phase: str, board_state: dict[str, Any]) -> None:
        units = board_state.get("units", {}) if isinstance(board_state, dict) else {}
        centers = board_state.get("centers", {}) if isinstance(board_state, dict) else {}
        for actor, unit_list in units.items():
            for unit in unit_list or []:
                location = self._unit_location(unit)
                if not location:
                    continue
                for observer in self.agents:
                    if observer == actor:
                        continue
                    observer_home = HOME_CENTER_CODES.get(observer, set())
                    observer_centers = {self._base_code(center) for center in centers.get(observer, []) or []}
                    if location in observer_home or location in observer_centers:
                        self._relationship_floor(
                            observer,
                            actor,
                            "Enemy",
                            f"{actor} currently occupies {location}, a home or owned supply center.",
                            phase,
                        )

    def _refresh_visible_relationship_profiles(
        self,
        board_state: dict[str, Any] | None = None,
        phase: str | None = None,
        submitted_orders: dict[str, list[str]] | None = None,
    ) -> None:
        board_state = board_state or self.game.get_state()
        phase = phase or self.game.get_current_phase()
        self._refresh_message_relationship_profiles()
        self._apply_board_position_relationship_updates(phase, board_state)
        for power_name in self.agents:
            self._refresh_human_reputation_profile(power_name, board_state, phase, submitted_orders)

    def _human_reputation_assessment(
        self,
        power_name: str,
        board_state: dict[str, Any] | None = None,
        submitted_orders: dict[str, list[str]] | None = None,
    ) -> dict[str, Any]:
        board_state = board_state or self.game.get_state()
        units = board_state.get("units", {}) if isinstance(board_state, dict) else {}
        centers = board_state.get("centers", {}) if isinstance(board_state, dict) else {}
        human_units = units.get(self.human_power, []) or []
        human_unit_locs = {self._unit_location(unit) for unit in human_units}
        power_home = HOME_CENTER_CODES.get(power_name, set())
        power_centers = {self._base_code(center) for center in centers.get(power_name, []) or []}
        occupied_home = sorted(loc for loc in human_unit_locs if loc in power_home)
        occupied_centers = sorted(loc for loc in human_unit_locs if loc in power_centers)

        recent_orders = self._recent_submitted_orders(self.human_power, limit=3)
        if submitted_orders and submitted_orders.get(self.human_power):
            recent_orders = [(self.game.get_current_phase(), submitted_orders[self.human_power])]
        latest_orders = recent_orders[-1][1] if recent_orders else []
        direct_targets = [dest for dest in (self._direct_move_destination(order) for order in latest_orders) if dest]
        targeted_home = sorted(dest for dest in direct_targets if dest in power_home or dest in power_centers)

        thread = self._private_messages_with_power(power_name, limit=10)
        human_text = " ".join(content.lower() for _, sender, content in thread if sender == self.human_power)
        support_request_index = -1
        for index, (_, sender, content) in enumerate(thread):
            if sender == power_name and "support" in content.lower():
                support_request_index = index
        human_sounded_agreeable = support_request_index > -1 and any(
            sender == self.human_power
            and index > support_request_index
            and re.search(r"\b(ok|okay|yes|sure|deal|support you|i can support|let'?s do|let us do|agree)\b", content.lower())
            for index, (_, sender, content) in enumerate(thread)
        )
        agent_requested_support = support_request_index > -1
        human_submitted_support = any(" S " in f" {order} " for order in latest_orders)
        broken_support_promise = human_sounded_agreeable and agent_requested_support and latest_orders and not human_submitted_support

        taunting_tone = bool(re.search(r"\b(lol|haha|you see|surprise)\b", human_text))
        severity = 0
        if occupied_home or occupied_centers or targeted_home:
            severity = 3
        elif broken_support_promise:
            severity = 2
        elif taunting_tone:
            severity = 1

        status = "Enemy" if severity >= 3 else "Unfriendly" if severity >= 2 else "Neutral"
        agent = self.agents.get(power_name)
        current_relationship = agent.relationships.get(self.human_power, "Neutral") if agent else "Neutral"
        lines = [
            f"Human power: {self.human_power}. Current relationship label: {current_relationship}.",
        ]
        if occupied_home:
            lines.append(f"- {self.human_power} currently has unit(s) in your home center(s): {', '.join(occupied_home)}.")
        if occupied_centers:
            lines.append(f"- {self.human_power} currently has unit(s) on your owned center(s): {', '.join(occupied_centers)}.")
        if targeted_home:
            lines.append(f"- Latest {self.human_power} orders targeted your home/owned center(s): {', '.join(targeted_home)}.")
        if broken_support_promise:
            lines.append("- Private thread indicates they agreed to support you, but their latest submitted orders contain no support order.")
        if taunting_tone:
            lines.append("- Recent human tone includes taunting/casual language after hostile board facts.")
        if recent_orders:
            compact_orders = " | ".join(f"{phase}: {'; '.join(orders[:8])}" for phase, orders in recent_orders[-2:])
            lines.append(f"- Recent {self.human_power} submitted orders: {compact_orders}.")
        if thread:
            compact_thread = " | ".join(
                f"{phase} {'Human' if sender == self.human_power else sender}: {content[:90]}"
                for phase, sender, content in thread[-5:]
            )
            lines.append(f"- Recent private thread: {compact_thread}.")
        lines.append(
            "- Assessment: "
            + (
                "treat the human as directly hostile and opportunistic; do not normalize this as harmless surprise."
                if severity >= 3
                else "treat the human as unreliable unless their next actions repair trust."
                if severity >= 2
                else "no concrete betrayal detected yet; still verify words against orders."
            )
        )
        return {"text": "\n".join(lines), "status": status, "severity": severity}

    def _refresh_human_reputation_profile(
        self,
        power_name: str,
        board_state: dict[str, Any] | None = None,
        phase: str | None = None,
        submitted_orders: dict[str, list[str]] | None = None,
    ) -> str:
        if power_name not in self.agents:
            return ""
        phase = phase or self.game.get_current_phase()
        assessment = self._human_reputation_assessment(power_name, board_state, submitted_orders)
        if assessment["severity"]:
            self._relationship_floor(
                power_name,
                self.human_power,
                assessment["status"],
                "Human reputation profile detected hostile or unreliable behavior.",
                phase,
            )
            self._add_diary_once(
                self.agents[power_name],
                phase,
                f"Human reputation profile for {self.human_power}:\n{assessment['text']}",
            )
        return assessment["text"]

    def _strategic_relationship_brief(self, power_name: str) -> str:
        lines = [
            "Strategic relationship map inferred from visible orders, board positions, and recorded messages.",
            "No hidden AI-to-AI private chats are assumed here.",
        ]
        agent = self.agents.get(power_name)
        if agent:
            own_rels = ", ".join(f"{p}: {s}" for p, s in sorted(agent.relationships.items()))
            lines.append(f"Your relationship labels: {own_rels}.")
        notable: list[str] = []
        for observer, other_agent in sorted(self.agents.items()):
            if observer == power_name:
                continue
            marked = [
                f"{target}={status}"
                for target, status in sorted(other_agent.relationships.items())
                if status != "Neutral"
            ]
            if marked:
                notable.append(f"{observer} sees {', '.join(marked)}")
        lines.append("Other inferred relationships: " + ("; ".join(notable[:10]) if notable else "none yet."))
        return "\n".join(lines)

    def _agent_summary(self) -> dict[str, dict[str, Any]]:
        return {
            p: {
                "model": agent.client.model_name,
                "goals": agent.goals,
                "relationships": agent.relationships,
                "diaryEntries": len(agent.full_private_diary),
            }
            for p, agent in self.agents.items()
        }

    def _possible_orders_for(self, power_name: str) -> dict[str, list[str]]:
        possible_orders = gather_possible_orders(self.game, power_name)
        if self.game.phase_type != "A":
            return possible_orders

        adjustment_need = self._adjustment_need(power_name)
        if adjustment_need == 0:
            return {}

        filtered: dict[str, list[str]] = {}
        for loc, choices in possible_orders.items():
            if adjustment_need > 0:
                legal_choices = [
                    order
                    for order in choices
                    if order.upper() == "WAIVE" or order.endswith(" B")
                ]
            else:
                legal_choices = [order for order in choices if order.endswith(" D")]
            if legal_choices:
                filtered[loc] = legal_choices
        return filtered

    async def send_message(self, recipient: str, content: str) -> dict[str, Any]:
        with self.lock:
            self._ensure_phase()
            recipient = recipient.upper().strip()
            if recipient in {"ALL", "PUBLIC"}:
                recipient = GLOBAL
            if recipient != GLOBAL and recipient not in self.game.powers:
                raise ValueError(f"Unknown recipient: {recipient}")
            content = content.strip()
            if not content:
                raise ValueError("Message content is required.")
            message = Message(
                phase=self.game.current_short_phase,
                sender=self.human_power,
                recipient=recipient,
                message=content,
                time_sent=None,
            )
            self.game.add_message(message)
            self.game_history.add_message(self.game.current_short_phase, self.human_power, recipient, content)
            self._record_human_message_for_agents(recipient, content)
            self._apply_message_relationship_update(self.human_power, recipient, content, self.game.get_current_phase())
            self.status = f"Sent message to {recipient}."
            snapshot = self.snapshot()
            checkpoint_phase = self.game.get_current_phase()
        await self._save_checkpoint(checkpoint_phase)
        return snapshot

    def _record_human_message_for_agents(self, recipient: str, content: str) -> None:
        phase = self.game.get_current_phase()
        if recipient == GLOBAL:
            targets = self.agents.values()
            prefix = "Public message"
        else:
            target = self.agents.get(recipient)
            targets = [target] if target else []
            prefix = f"Private message from {self.human_power}"
        for agent in targets:
            if agent:
                agent.add_diary_entry(f"{prefix}: {content}", phase)

    def _recent_agent_replies(self, power_name: str, limit: int = 4) -> list[tuple[str, str]]:
        replies: list[tuple[str, str]] = []
        for phase in reversed(self.game_history.phases):
            for msg in reversed(phase.messages):
                if msg.sender == power_name and msg.recipient == self.human_power:
                    replies.append((phase.name, msg.content))
                    if len(replies) >= limit:
                        return list(reversed(replies))
        return list(reversed(replies))

    def _recent_agent_replies_for_prompt(self, power_name: str, limit: int = 4) -> str:
        replies = self._recent_agent_replies(power_name, limit=limit)
        if not replies:
            return "(No previous private replies to the human.)"
        return "\n".join(f"{phase}: {content}" for phase, content in replies)

    def _normalize_reply_for_duplicate_check(self, content: str | None) -> str:
        text = str(content or "").lower()
        text = re.sub(r"\b(spring|fall|winter)\s+\d{4}\s+(orders|retreats|builds)\b", " ", text)
        text = re.sub(r"\b(you|human)\s+to\s+[a-z]+\b", " ", text)
        text = re.sub(r"\b[a-z]+\s+to\s+(you|human|france)\b", " ", text)
        text = re.sub(r"[^a-z0-9]+", " ", text)
        return re.sub(r"\s+", " ", text).strip()

    def _duplicate_reply_match(self, content: str | None, previous_replies: list[tuple[str, str]]) -> str | None:
        normalized = self._normalize_reply_for_duplicate_check(content)
        if len(normalized) < 24:
            return None
        for _phase, previous in reversed(previous_replies):
            previous_normalized = self._normalize_reply_for_duplicate_check(previous)
            if len(previous_normalized) < 24:
                continue
            if normalized == previous_normalized:
                return previous
            if SequenceMatcher(None, normalized, previous_normalized).ratio() >= 0.86:
                return previous
        return None

    def _current_human_units_text(self, board_state: dict[str, Any]) -> str:
        units = board_state.get("units", {}) if isinstance(board_state, dict) else {}
        human_units = [str(unit) for unit in units.get(self.human_power, []) or []]
        return ", ".join(human_units) or "none"

    def _reply_current_board_conflict(self, content: str | None, board_state: dict[str, Any]) -> str | None:
        if not content:
            return None
        units = board_state.get("units", {}) if isinstance(board_state, dict) else {}
        human_units = [str(unit) for unit in units.get(self.human_power, []) or []]
        human_locations = {self._unit_location(unit) for unit in human_units}
        if not human_locations:
            return None

        text = str(content)
        for match in re.finditer(
            r"\b([AF])\s+([A-Z]{3})(?:/[A-Z]{2})?\s+(?:is\s+)?(?:still\s+)?(?:in|at|on)\s+([A-Z]{3})(?:/[A-Z]{2})?\b",
            text,
            flags=re.IGNORECASE,
        ):
            unit_loc = self._base_code(match.group(2))
            claimed_loc = self._base_code(match.group(3))
            if unit_loc == claimed_loc and unit_loc not in human_locations:
                return (
                    f"Draft says {self.human_power} has {match.group(1).upper()} {unit_loc}, "
                    f"but current {self.human_power} units are: {self._current_human_units_text(board_state)}."
                )

        for match in re.finditer(
            r"\b(?:i\s+)?see\s+(?:your\s+)?([AF])\s+([A-Z]{3})(?:/[A-Z]{2})?\b",
            text,
            flags=re.IGNORECASE,
        ):
            unit_loc = self._base_code(match.group(2))
            if unit_loc not in human_locations:
                return (
                    f"Draft says it sees {self.human_power} {match.group(1).upper()} {unit_loc}, "
                    f"but current {self.human_power} units are: {self._current_human_units_text(board_state)}."
                )

        for match in re.finditer(
            r"\b(?:moved|ordered|sent)\s+(?:your\s+)?([AF])\s+([A-Z]{3})(?:/[A-Z]{2})?\s+(?:-|to|into)\s+([A-Z]{3})(?:/[A-Z]{2})?\b",
            text,
            flags=re.IGNORECASE,
        ):
            target_loc = self._base_code(match.group(3))
            if target_loc not in human_locations:
                return (
                    f"Draft says {self.human_power} moved {match.group(1).upper()} {self._base_code(match.group(2))} to {target_loc}, "
                    f"but current {self.human_power} units are: {self._current_human_units_text(board_state)}."
                )

        if re.search(r"\b(?:didn't|did not|never)\s+(?:actually\s+)?(?:retreat|move|leave)\b", text, flags=re.IGNORECASE):
            latest_move_locations = {loc for loc in human_locations if re.search(rf"\b{re.escape(loc)}\b", text, flags=re.IGNORECASE)}
            if latest_move_locations:
                return (
                    f"Draft denies a move into {', '.join(sorted(latest_move_locations))}, "
                    f"but current {self.human_power} units include: {self._current_human_units_text(board_state)}."
                )
        return None

    def _board_conflict_reply_fallback(
        self,
        latest_human_message: str,
        board_state: dict[str, Any],
        conflict: str,
    ) -> str:
        human_units = self._current_human_units_text(board_state)
        latest = str(latest_human_message or "").upper()
        if "SER" in latest or "ALB" in latest:
            return (
                f"I checked the current board: {self.human_power} has {human_units}. "
                "You did leave Serbia for Albania. I should judge the position from that."
            )
        return (
            f"I need to correct my read of the current board: {self.human_power} has {human_units}. "
            "Let's talk from that position."
        )

    def _flat_possible_orders(self, possible_orders: dict[str, list[str]]) -> set[str]:
        return {str(order).upper() for choices in (possible_orders or {}).values() for order in choices or []}

    def _power_center_locations(self, board_state: dict[str, Any], power_name: str) -> set[str]:
        centers = board_state.get("centers", {}) if isinstance(board_state, dict) else {}
        return {self._base_code(center) for center in centers.get(power_name, []) or [] if self._base_code(center)}

    def _support_claims_from_reply(self, content: str | None) -> list[dict[str, str]]:
        if not content:
            return []
        text = re.sub(r"\s+", " ", str(content).upper())
        province = r"[A-Z]{3}(?:/[A-Z]{2})?"
        claims: list[dict[str, str]] = []

        def add_claim(
            support_loc: str,
            target_loc: str,
            supported_loc: str = "",
            support_type: str = "",
            supported_type: str = "",
            raw: str = "",
        ) -> None:
            claim = {
                "support_loc": self._base_code(support_loc),
                "target_loc": self._base_code(target_loc),
                "supported_loc": self._base_code(supported_loc),
                "support_type": support_type.upper(),
                "supported_type": supported_type.upper(),
                "raw": raw.strip(),
            }
            if claim["support_loc"] and claim["target_loc"]:
                claims.append(claim)

        for match in re.finditer(
            rf"\b([AF])\s+({province})\s+S\s+([AF])\s+({province})(?:\s*-\s*({province}))?",
            text,
        ):
            add_claim(
                match.group(2),
                match.group(5) or match.group(4),
                match.group(4),
                match.group(1),
                match.group(3),
                match.group(0),
            )

        for match in re.finditer(
            rf"\b([AF])\s+({province})\s+(?:CAN|COULD|WILL|WOULD|MAY)?\s*SUPPORT\b[^.?!;]{{0,120}}?\b(?:TO|INTO)\s+({province})\b[^.?!;]{{0,80}}?\bFROM\s+({province})\b",
            text,
        ):
            add_claim(match.group(2), match.group(3), match.group(4), match.group(1), raw=match.group(0))

        for match in re.finditer(
            rf"\bSUPPORT(?:S|ING)?\s+(?:YOUR\s+|THE\s+)?([AF])?\s*({province})\b[^.?!;]{{0,100}}?\b(?:TO|INTO)\s+({province})\b[^.?!;]{{0,80}}?\bFROM\s+({province})\b",
            text,
        ):
            add_claim(match.group(4), match.group(3), match.group(2), supported_type=match.group(1) or "", raw=match.group(0))

        for match in re.finditer(
            rf"\bFROM\s+({province})\b[^.?!;]{{0,80}}?\bSUPPORT(?:S|ING)?\b[^.?!;]{{0,100}}?\b(?:TO|INTO)\s+({province})\b",
            text,
        ):
            add_claim(match.group(1), match.group(2), raw=match.group(0))

        for match in re.finditer(
            rf"\bSUPPORT(?:S|ING)?\s+(?:YOUR\s+|THE\s+)?([AF])?\s*({province})"
            rf"(?:\s+(FLEET|ARMY))?\b[^.?!;]{{0,100}}?\b(?:TO|INTO)\s+({province})\b"
            rf"[^.?!;]{{0,100}}?\bWITH\s+((?:(?:[AF]\s+)?{province})(?:\s*(?:,|AND)\s*(?:[AF]\s+)?{province})*)",
            text,
        ):
            supported_type = match.group(1) or ({"FLEET": "F", "ARMY": "A"}.get(match.group(3) or "") or "")
            target_loc = match.group(4)
            support_refs = re.findall(rf"(?:\b([AF])\s+)?\b(?!AND\b|OR\b)({province})\b", match.group(5))
            for support_type, support_loc in support_refs:
                add_claim(
                    support_loc,
                    target_loc,
                    match.group(2),
                    support_type=support_type or "",
                    supported_type=supported_type,
                    raw=match.group(0),
                )

        deduped: list[dict[str, str]] = []
        seen: set[tuple[str, str, str, str]] = set()
        for claim in claims:
            key = (
                claim["support_loc"],
                claim["target_loc"],
                claim.get("supported_loc", ""),
                claim.get("raw", ""),
            )
            if key in seen:
                continue
            seen.add(key)
            deduped.append(claim)
        return deduped

    def _support_target_sentences_from_reply(self, content: str | None) -> list[tuple[str, list[str]]]:
        if not content:
            return []
        province = r"[A-Z]{3}(?:/[A-Z]{2})?"
        sentences = re.split(r"(?<=[.?!;])\s+", str(content or ""))
        results: list[tuple[str, list[str]]] = []
        for sentence in sentences:
            normalized = re.sub(r"\s+", " ", sentence.strip())
            if not re.search(r"\bsupport(?:s|ing)?\b", normalized, flags=re.IGNORECASE):
                continue
            if re.search(r"\b(?:can'?t|cannot|won'?t|don'?t|do not|not|no)\b[^.?!;]{0,70}\bsupport", normalized, flags=re.IGNORECASE):
                continue
            targets = [self._base_code(match.group(1)) for match in re.finditer(rf"\b(?:TO|INTO)\s+({province})\b", normalized, flags=re.IGNORECASE)]
            targets.extend(
                self._base_code(match.group(1))
                for match in re.finditer(rf"\bOR\s+({province})\b", normalized, flags=re.IGNORECASE)
                if re.search(r"\b(?:TO|INTO)\s+[A-Z]{3}", normalized[: match.start()], flags=re.IGNORECASE)
            )
            targets = [target for target in dict.fromkeys(targets) if target]
            if targets:
                results.append((normalized, targets))
        return results

    def _reply_tactical_legality_conflict(
        self,
        content: str | None,
        power_name: str,
        possible_orders: dict[str, list[str]],
        board_state: dict[str, Any],
    ) -> str | None:
        if not content:
            return None
        units = board_state.get("units", {}) if isinstance(board_state, dict) else {}
        legal_orders = self._flat_possible_orders(possible_orders)
        own_centers = self._power_center_locations(board_state, power_name)
        own_occupied = {
            self._unit_location(unit)
            for unit in (units.get(power_name, []) or [])
            if self._unit_location(unit)
        }
        concession_words = re.compile(r"\b(?:cede|concede|give you|hand over|evacuate|vacate|let you take|trade you|concession)\b", re.IGNORECASE)
        for sentence, targets in self._support_target_sentences_from_reply(content):
            if concession_words.search(sentence):
                continue
            for target_loc in targets:
                if target_loc in own_occupied:
                    return f"Draft offers support into {target_loc}, but {power_name} currently has a unit there."
                if target_loc in own_centers:
                    return (
                        f"Draft offers support into {target_loc}, but {target_loc} is one of {power_name}'s own supply centers. "
                        "Do not offer that casually; only say it if explicitly ceding or trading the center."
                    )

        conflicts: list[tuple[tuple[str, str, str], str]] = []
        valid_pairs: set[tuple[str, str, str]] = set()

        for claim in self._support_claims_from_reply(content):
            support_loc = claim["support_loc"]
            target_loc = claim["target_loc"]
            claim_pair = (support_loc, claim.get("supported_loc") or "", target_loc)
            support_unit = self._unit_for_power_at_location(units, power_name, support_loc)
            if not support_unit:
                conflicts.append((claim_pair, f"{power_name} has no current unit at {support_loc} to give that support."))
                continue
            support_type, support_full_loc = support_unit
            supported_loc = claim.get("supported_loc") or ""
            supported = self._unit_at_location(units, supported_loc) if supported_loc else None
            supported_type = claim.get("supported_type") or (supported[1] if supported else "A")
            support_order = (
                f"{support_type} {support_full_loc} S {supported_type} {supported_loc} - {target_loc}"
                if supported_loc and target_loc != supported_loc
                else f"{support_type} {support_full_loc} S {supported_type} {supported_loc or target_loc}"
            ).upper()

            if legal_orders and support_order not in legal_orders:
                conflicts.append((claim_pair, f"{support_order} is not in {power_name}'s current legal-order list."))
                continue
            if not self.game.map.abuts(support_type, support_full_loc, "S", target_loc):
                conflicts.append(
                    (
                        claim_pair,
                        f"{support_type} {support_full_loc} cannot support into {target_loc}; "
                        "a supporting unit must be able to move to the destination being attacked or held.",
                    )
                )
                continue
            valid_pairs.add(claim_pair)
        for claim_pair, conflict in conflicts:
            if claim_pair not in valid_pairs:
                return conflict
        return None

    def _tactical_conflict_reply_fallback(
        self,
        power_name: str,
        conflict: str,
    ) -> str:
        phase_kind = {
            "M": "movement",
            "R": "retreat",
            "A": "adjustment",
        }.get(self.game.phase_type, self.game.phase_type)
        phase_note = (
            f"This is a {phase_kind} phase, so I should not promise an immediate support order. "
            if self.game.phase_type != "M"
            else ""
        )
        return (
            f"You're right to question that. {conflict} {phase_note}"
            "Let's coordinate from legal adjacent orders next movement phase."
        )

    def _non_repeating_reply_fallback(
        self,
        power_name: str,
        latest_human_message: str,
        repeated_reply: str,
        board_state: dict[str, Any],
    ) -> str:
        centers = board_state.get("centers", {}) if isinstance(board_state, dict) else {}
        human_units = board_state.get("units", {}).get(self.human_power, []) if isinstance(board_state, dict) else []
        power_centers = {self._base_code(center) for center in centers.get(power_name, []) or []}
        human_on_power_centers = sorted(
            loc for loc in (self._unit_location(unit) for unit in human_units) if loc in power_centers
        )
        center_text = ", ".join(MAP_METADATA["provinceNames"].get(loc, loc) for loc in human_on_power_centers)
        latest = str(latest_human_message or "").lower()

        if re.search(r"\b(repeat|repeating|same|wtf|again)\b", latest):
            if center_text:
                return (
                    f"I hear you. My answer repeated because {center_text} is still the unresolved issue. "
                    "Give me a concrete evacuation or compensation order this turn, and I will reconsider cooperation."
                )
            return (
                "I hear you. My position has not changed, but I should not keep repeating the same line. "
                "Give me one concrete order you want from me this turn, and what you will do in return."
            )

        if center_text:
            return (
                f"The obstacle is still {center_text}. I need a concrete concession there before I spend orders helping your plan."
            )
        return (
            "I am not accepting that as-is. Make the proposal concrete: name the exact order you want from me and the exact order you will issue in return."
        )

    async def ask_agent_reply(self, power_name: str) -> dict[str, Any]:
        power_name = power_name.upper().strip()
        with self.lock:
            self._set_busy(f"Asking {power_name} for a reply...")
        try:
            self._require_real_llm_agents()
            if power_name == self.human_power or power_name not in self.agents:
                raise ValueError(f"{power_name} is not an AI-controlled power.")

            agent = self.agents[power_name]
            phase = self.game.get_current_phase()
            possible_orders = self._possible_orders_for(power_name)
            board_state = self.game.get_state()
            relationship_intel = self._refresh_human_reputation_profile(power_name, board_state, phase)
            strategic_relationships = self._strategic_relationship_brief(power_name)
            tactical_commitments = self._tactical_commitment_brief(power_name, possible_orders)
            private_thread = self._private_thread_for_prompt(power_name)
            latest_human_message = self._latest_human_message_for(power_name)
            previous_replies = self._recent_agent_replies(power_name)
            previous_replies_brief = self._recent_agent_replies_for_prompt(power_name)
            legal_orders_brief = self._possible_orders_brief(possible_orders)
            board_fact_brief = self._agent_board_fact_brief(power_name, board_state, possible_orders)

            context = build_context_prompt(
                self.game,
                board_state,
                power_name,
                possible_orders,
                self.game_history,
                agent_goals=agent.goals,
                agent_relationships=agent.relationships,
                agent_private_diary=agent.format_private_diary_for_prompt(),
                prompts_dir=agent.prompts_dir,
                include_messages=True,
                include_order_history=True,
                include_possible_moves_summary=True,
            )
            raw_prompt = (
                f"{context}\n\n"
                f"RELATIONSHIP INTELLIGENCE ABOUT {self.human_power}:\n{relationship_intel}\n\n"
                f"LOW-COST STRATEGIC RELATIONSHIP MAP:\n{strategic_relationships}\n\n"
                f"ACTIVE ALLIANCES AND TACTICAL COMMITMENTS:\n{tactical_commitments}\n\n"
                f"RECENT PRIVATE THREAD WITH {self.human_power}:\n{private_thread}\n\n"
                f"RECENT REPLIES YOU ALREADY SENT TO {self.human_power}:\n{previous_replies_brief}\n\n"
                f"LATEST MESSAGE FROM {self.human_power}: {latest_human_message or '(none)'}\n\n"
                f"TACTICAL FACTS YOU MUST CHECK BEFORE REPLYING:\n{board_fact_brief}\n\n"
                f"LEGAL ORDERS AVAILABLE TO {power_name} THIS PHASE:\n{legal_orders_brief}\n\n"
                f"You are {power_name}. The human player controls {self.human_power}. "
                f"Decide whether to send exactly one private diplomatic reply to {self.human_power}. "
                "Use only information your power can legitimately know from public press, your private messages, "
                "your private diary, and the board state. Do not reveal private talks with other powers. "
                "Before replying, silently compare the latest human message with the tactical facts. "
                "Treat TACTICAL FACTS as authoritative over old private thread text or your previous replies. "
                "If the facts contradict something you said earlier, acknowledge the current board accurately. "
                "Do not call a province open if the last submitted orders or current units show a unit there. "
                "If you have no legal orders this phase, do not claim you can act immediately this phase. "
                "If relationship intelligence says the human broke a promise, occupied your home center, or directly harmed you, "
                "respond with appropriate suspicion, anger, demands, or strategic coldness rather than naive friendliness. "
                "Do not describe a direct hostile occupation as merely surprising unless you are intentionally being diplomatic. "
                "Treat concrete alliance commitments as tactical obligations: if you promised support, requested support, agreed to a DMZ, or coordinated a convoy, "
                "address that explicitly and do not ignore it for generic expansion. "
                "When promising support, convoy, retreat, build, or movement, copy an exact legal order from the legal-order list or clearly say it is only a future idea. "
                "Never claim you can order a unit to support itself or issue an order that is not currently legal. "
                "Support rule: the supporting unit must be able to move to the destination being attacked or held; being adjacent to the attacking unit is not enough. "
                "If you name multiple support units, every named support unit must have its own exact legal support order. "
                "Do not casually offer support into a center you own or a province you occupy; only do that if you explicitly mean to cede, trade, or abandon it. "
                "Answer the latest human message directly. If they ask for ideas, propose one or two concrete, legal tactical ideas grounded in the current phase and units. "
                "Do not offer support into a province the human already occupies unless you clearly mean a later-phase plan. "
                "Keep it under 80 words. Do not repeat your previous reply, even if your strategic condition has not changed; acknowledge the new message and vary the wording. "
                "Do not explain your hidden reasoning. "
                "You may be honest, evasive, cooperative, deceptive, or silent if strategically justified. "
                "Return strict JSON only: {\"send\":true,\"content\":\"your message\"} or {\"send\":false,\"content\":\"\"}."
            )
            previous_cap = self._cap_client_tokens(agent.client, self.args.chat_max_tokens)
            raw_response_parts: list[str] = []
            content: str | None = None
            duplicate_match: str | None = None
            board_conflict: str | None = None
            tactical_conflict: str | None = None
            try:
                prompt = raw_prompt
                for duplicate_attempt in range(2):
                    raw_response_part = await run_llm_and_log(
                        client=agent.client,
                        prompt=prompt,
                        power_name=power_name,
                        phase=phase,
                        response_type="direct_human_reply",
                        temperature=0.15 if duplicate_attempt == 0 else 0.3,
                        attempts=3,
                    )
                    raw_response_parts.append(raw_response_part)
                    content = self._parse_direct_reply(raw_response_part)
                    duplicate_match = self._duplicate_reply_match(content, previous_replies)
                    board_conflict = self._reply_current_board_conflict(content, board_state)
                    tactical_conflict = self._reply_tactical_legality_conflict(
                        content,
                        power_name,
                        possible_orders,
                        board_state,
                    )
                    if not content or (not duplicate_match and not board_conflict and not tactical_conflict):
                        break
                    if duplicate_attempt == 0:
                        warnings = []
                        if duplicate_match:
                            warnings.append(
                                "Your draft repeated this previous reply almost verbatim: "
                                f"{duplicate_match}"
                            )
                        if board_conflict:
                            warnings.append(
                                "Your draft contradicted the authoritative current board: "
                                f"{board_conflict}"
                            )
                        if tactical_conflict:
                            warnings.append(
                                "Your draft proposed or implied an illegal tactical order: "
                                f"{tactical_conflict}"
                            )
                        prompt = (
                            f"{raw_prompt}\n\n"
                            "BACKEND REPLY WARNING:\n"
                            + "\n".join(warnings)
                            + "\nWrite a different response to the latest human message. Current board facts override old chat thread text. "
                            "If your condition is unchanged, say so in new words and ask for a concrete order trade. "
                            "Do not name a support, move, convoy, build, or retreat unless it is legal from the current board."
                        )
                if content and duplicate_match:
                    content = self._non_repeating_reply_fallback(
                        power_name,
                        latest_human_message,
                        duplicate_match,
                        board_state,
                    )
                    raw_response_parts.append(f"[backend duplicate guard fallback] {content}")
                if content and board_conflict:
                    content = self._board_conflict_reply_fallback(
                        latest_human_message,
                        board_state,
                        board_conflict,
                    )
                    raw_response_parts.append(f"[backend current-board guard fallback] {content}")
                if content and tactical_conflict:
                    content = self._tactical_conflict_reply_fallback(power_name, tactical_conflict)
                    raw_response_parts.append(f"[backend tactical-order guard fallback] {content}")
            finally:
                self._restore_client_tokens(agent.client, previous_cap)
            raw_response = "\n\n--- backend direct reply attempt ---\n\n".join(raw_response_parts)
            success = "Success"

            with self.lock:
                if content:
                    message = Message(
                        phase=self.game.current_short_phase,
                        sender=power_name,
                        recipient=self.human_power,
                        message=content,
                        time_sent=None,
                    )
                    self.game.add_message(message)
                    self.game_history.add_message(self.game.current_short_phase, power_name, self.human_power, content)
                    agent.add_diary_entry(f"Private reply to {self.human_power}: {content}", phase)
                    self.status = f"{power_name} replied privately."
                else:
                    agent.add_diary_entry(f"Chose not to reply privately to {self.human_power}.", phase)
                    self.status = f"{power_name} chose not to reply."

            await log_llm_response_async(
                log_file_path=str(self.llm_log_file_path),
                model_name=agent.client.model_name,
                power_name=power_name,
                phase=phase,
                response_type="direct_human_reply",
                raw_input_prompt=raw_prompt,
                raw_response=raw_response,
                success=success,
            )
            await self._save_checkpoint(phase)
            with self.lock:
                self.busy = False
                return self.snapshot()
        finally:
            with self.lock:
                self.busy = False

    def _parse_direct_reply(self, raw_response: str) -> str | None:
        raw_response = self._strip_response_fence(raw_response)
        try:
            parsed = json.loads(raw_response)
            if isinstance(parsed, dict):
                if parsed.get("send") is False:
                    return None
                if parsed.get("content"):
                    return str(parsed["content"]).strip()[:900]
        except json.JSONDecodeError:
            pass
        match = re.search(r'"content"\s*:\s*"(?P<content>(?:\\.|[^"\\])*)', raw_response, re.DOTALL)
        if match:
            return self._clean_jsonish_content(match.group("content"))[:900] or None
        cleaned = raw_response.strip()
        if cleaned.startswith("{") and '"send"' in cleaned:
            cleaned = re.sub(r'^\s*\{+\s*"send"\s*:\s*(?:true|false)\s*,?\s*', "", cleaned, flags=re.IGNORECASE)
        return cleaned[:900] if cleaned else None

    def _strip_response_fence(self, raw_response: str) -> str:
        cleaned = str(raw_response or "").strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
            cleaned = re.sub(r"\s*```$", "", cleaned)
        return cleaned.strip()

    def _clean_jsonish_content(self, content: str) -> str:
        cleaned = content.replace('\\"', '"').replace("\\n", "\n").replace("\\/", "/").strip()
        cleaned = re.sub(r'"\s*,?\s*"?send"?\s*:.*$', "", cleaned, flags=re.IGNORECASE | re.DOTALL)
        cleaned = re.sub(r'"\s*}\s*$', "", cleaned)
        cleaned = cleaned.rstrip('"} \n\t')
        return cleaned.strip()

    def _private_thread_for_prompt(self, other_power: str, limit: int = 8) -> str:
        lines: list[str] = []
        for phase in self.game_history.phases:
            for msg in phase.messages:
                between_players = (
                    (msg.sender == self.human_power and msg.recipient == other_power)
                    or (msg.sender == other_power and msg.recipient == self.human_power)
                )
                if between_players:
                    sender = "Human" if msg.sender == self.human_power else other_power
                    lines.append(f"{phase.name} {sender}: {msg.content}")
        return "\n".join(lines[-limit:]) or "(No private messages yet.)"

    def _latest_human_message_for(self, other_power: str) -> str:
        for phase in reversed(self.game_history.phases):
            for msg in reversed(phase.messages):
                if msg.sender == self.human_power and msg.recipient == other_power:
                    return msg.content
        return ""

    def _possible_orders_brief(self, possible_orders: dict[str, list[str]], limit_per_unit: int = 8) -> str:
        lines = []
        for loc, orders in possible_orders.items():
            if not orders:
                continue
            sample = "; ".join(orders[:limit_per_unit])
            extra = f"; +{len(orders) - limit_per_unit} more" if len(orders) > limit_per_unit else ""
            lines.append(f"{loc}: {sample}{extra}")
        return "\n".join(lines) or "(No legal orders needed.)"

    def submit_orders(self, orders: list[str]) -> dict[str, Any]:
        with self.lock:
            phase = self.game.get_current_phase()
            possible_orders = self._possible_orders_for(self.human_power)
            valid, invalid = self._validate_orders(
                self.human_power,
                orders,
                possible_orders,
                complete_missing=False,
                allow_adjustment_defaults=False,
            )
            if invalid:
                raise ValueError("Invalid orders: " + "; ".join(invalid))
            self.pending_human_orders[phase] = valid
            self._save_session_state()
            self.status = f"Saved {len(valid)} orders for {self.human_power}."
            return self.snapshot()

    async def run_ai_press(self, rounds: int | None = None) -> dict[str, Any]:
        with self.lock:
            self._set_busy("AI powers are negotiating...")
        try:
            self._require_real_llm_agents()
            max_rounds = rounds or self.args.num_negotiation_rounds
            if not self.game.current_short_phase.endswith("M"):
                raise ValueError("Press is only available during movement phases.")
            if max_rounds < 1:
                max_rounds = 1
            with self.lock:
                self._ensure_phase()
                board_state = self.game.get_state()
                phase = self.game.get_current_phase()
                self._refresh_visible_relationship_profiles(board_state, phase)
                self._refresh_agent_tactical_contexts(board_state, phase)
            previous_caps = {
                power_name: self._cap_client_tokens(agent.client, self.args.chat_max_tokens)
                for power_name, agent in self.agents.items()
            }
            try:
                await conduct_negotiations(
                    self.game,
                    self.agents,
                    self.game_history,
                    self.model_error_stats,
                    log_file_path=str(self.llm_log_file_path),
                    max_rounds=max_rounds,
                )
            finally:
                for power_name, previous_cap in previous_caps.items():
                    self._restore_client_tokens(self.agents[power_name].client, previous_cap)
            with self.lock:
                phase = self.game.get_current_phase()
                self._refresh_message_relationship_profiles()
                self._refresh_agent_tactical_contexts(self.game.get_state(), phase)
                for agent in self.agents.values():
                    agent.add_diary_entry(f"Negotiation round completed in {phase}.", phase)
                self.status = f"Completed {max_rounds} AI press round(s)."
            await self._save_checkpoint(phase)
            with self.lock:
                self.busy = False
                return self.snapshot()
        finally:
            with self.lock:
                self.busy = False

    def _order_is_hold(self, order: str) -> bool:
        return str(order or "").strip().endswith(" H")

    def _order_is_active_movement(self, order: str) -> bool:
        padded = f" {str(order or '').strip()} "
        return (" - " in padded or " S " in padded or " C " in padded) and not padded.strip().endswith((" B", " D"))

    def _too_many_holds(
        self,
        orders: list[str],
        possible_orders: dict[str, list[str]],
    ) -> bool:
        if self.game.phase_type != "M" or not possible_orders:
            return False
        orderable_count = len(possible_orders)
        if orderable_count < 3:
            return False
        active_capable = sum(
            1 for choices in possible_orders.values() if any(self._order_is_active_movement(order) for order in choices)
        )
        if active_capable < max(2, orderable_count // 2):
            return False
        holds = sum(1 for order in orders if self._order_is_hold(order))
        active_orders = sum(1 for order in orders if self._order_is_active_movement(order))
        return holds >= max(3, int(orderable_count * 0.67)) and active_orders <= max(1, orderable_count // 4)

    def _active_order_examples(self, possible_orders: dict[str, list[str]], limit: int = 18) -> str:
        examples: list[str] = []
        for loc, choices in possible_orders.items():
            active = [order for order in choices or [] if self._order_is_active_movement(order)]
            if active:
                examples.append(f"{loc}: {'; '.join(active[:4])}")
            if len(examples) >= limit:
                break
        return "\n".join(examples) or "(No active movement orders available.)"

    async def _generate_ai_orders(
        self,
        power_name: str,
        agent: DiplomacyAgent,
        board_state: dict[str, Any],
        phase: str,
        possible_orders: dict[str, list[str]],
    ) -> dict[str, list[str]]:
        relationship_intel = self._refresh_human_reputation_profile(power_name, board_state, phase)
        strategic_relationships = self._strategic_relationship_brief(power_name)
        tactical_commitments = self._tactical_commitment_brief(power_name, possible_orders)
        order_diary_context = "\n\n".join(
            part
            for part in [
                agent.get_latest_phase_diary_entries(),
                f"RELATIONSHIP INTELLIGENCE ABOUT {self.human_power}:\n{relationship_intel}",
                f"LOW-COST STRATEGIC RELATIONSHIP MAP:\n{strategic_relationships}",
                f"ACTIVE ALLIANCES AND TACTICAL COMMITMENTS:\n{tactical_commitments}",
            ]
            if part
        )
        if isinstance(agent.client, MockModelClient):
            raw_orders = await agent.client.get_orders(
                self.game,
                board_state,
                power_name,
                possible_orders,
                self.game_history,
                self.model_error_stats,
                str(self.llm_log_file_path),
                phase,
            )
        else:
            async def request_orders(extra_context: str = "") -> list[str]:
                return await agent.client.get_orders(
                    game=self.game,
                    board_state=board_state,
                    power_name=power_name,
                    possible_orders=possible_orders,
                    conversation_text=self.game_history,
                    model_error_stats=self.model_error_stats,
                    log_file_path=str(self.llm_log_file_path),
                    phase=phase,
                    agent_goals=agent.goals,
                    agent_relationships=agent.relationships,
                    agent_private_diary_str="\n\n".join(part for part in [order_diary_context, extra_context] if part),
                )

            previous_cap = self._cap_client_tokens(agent.client, self.args.order_max_tokens)
            try:
                raw_orders = await request_orders()
            finally:
                self._restore_client_tokens(agent.client, previous_cap)

        valid, invalid = self._validate_orders(
            power_name,
            raw_orders,
            possible_orders,
            complete_missing=True,
            allow_adjustment_defaults=True,
        )
        if not isinstance(agent.client, MockModelClient) and self._too_many_holds(valid, possible_orders):
            warning = (
                "BACKEND ORDER WARNING: your previous draft was too passive and used holds for most units despite legal "
                "moves/supports/convoys. In Diplomacy, idle units usually lose tempo. Revise with active legal orders "
                "unless a hold directly prevents a concrete loss. Use only exact orders from possible_orders.\n"
                f"Previous accepted draft: {'; '.join(valid)}\n"
                f"Examples of active legal choices:\n{self._active_order_examples(possible_orders)}"
            )
            previous_cap = self._cap_client_tokens(agent.client, self.args.order_max_tokens)
            try:
                revised_raw_orders = await request_orders(warning)
            finally:
                self._restore_client_tokens(agent.client, previous_cap)
            revised_valid, revised_invalid = self._validate_orders(
                power_name,
                revised_raw_orders,
                possible_orders,
                complete_missing=True,
                allow_adjustment_defaults=True,
            )
            if not self._too_many_holds(revised_valid, possible_orders) or (
                sum(1 for order in revised_valid if self._order_is_active_movement(order))
                > sum(1 for order in valid if self._order_is_active_movement(order))
            ):
                logger.info("Replaced passive %s orders after backend active-order warning.", power_name)
                valid, invalid = revised_valid, revised_invalid
        return {"valid": valid, "invalid": invalid}

    async def resolve_phase(self, human_orders: list[str] | None = None) -> dict[str, Any]:
        with self.lock:
            self._set_busy("Resolving phase...")

        try:
            with self.lock:
                self._ensure_phase()
                phase = self.game.get_current_phase()
                human_possible = self._possible_orders_for(self.human_power)
                if human_possible and isinstance(human_orders, list):
                    valid, invalid = self._validate_orders(
                        self.human_power,
                        human_orders,
                        human_possible,
                        complete_missing=True,
                        allow_adjustment_defaults=False,
                    )
                    if invalid:
                        raise ValueError("Invalid orders: " + "; ".join(invalid))
                    self.pending_human_orders[phase] = valid
                    self._save_session_state()

                current_human_orders = self.pending_human_orders.get(phase)
                if human_possible and current_human_orders is None:
                    if self.game.phase_type != "M":
                        raise ValueError("Choose the required retreat, build, waive, or disband orders before finishing.")
                    current_human_orders = self._fallback_orders(human_possible, self.human_power, prefer_active=False)
                    self.pending_human_orders[phase] = current_human_orders
                    self._save_session_state()
                elif human_possible:
                    valid, invalid = self._validate_orders(
                        self.human_power,
                        current_human_orders,
                        human_possible,
                        complete_missing=True,
                        allow_adjustment_defaults=False,
                    )
                    if invalid:
                        raise ValueError("Invalid orders: " + "; ".join(invalid))
                    current_human_orders = valid
                    self.pending_human_orders[phase] = current_human_orders
                    self._save_session_state()

            self._require_real_llm_agents()
            board_state = self.game.get_state()
            self._refresh_visible_relationship_profiles(board_state, phase)
            self._refresh_agent_tactical_contexts(board_state, phase)
            submitted_orders: dict[str, list[str]] = defaultdict(list)
            accepted_orders: dict[str, list[str]] = {}
            invalid_orders: dict[str, list[str]] = {}
            order_tasks: list[tuple[str, dict[str, list[str]], asyncio.Task[dict[str, list[str]]]]] = []

            for power_name, agent in self.agents.items():
                if self.game.powers[power_name].is_eliminated():
                    accepted_orders[power_name] = []
                    continue
                possible_orders = self._possible_orders_for(power_name)
                if not possible_orders:
                    accepted_orders[power_name] = []
                    continue
                order_tasks.append(
                    (
                        power_name,
                        possible_orders,
                        asyncio.create_task(self._generate_ai_orders(power_name, agent, board_state, phase, possible_orders)),
                    )
                )

            if order_tasks:
                results = await asyncio.gather(*(task for _, _, task in order_tasks), return_exceptions=True)
            else:
                results = []

            for (power_name, possible_orders, _task), result in zip(order_tasks, results):
                if isinstance(result, Exception):
                    logger.error("Order generation failed for %s; using fallback orders: %s", power_name, result)
                    result = {"valid": self._fallback_orders(possible_orders, power_name, prefer_active=True), "invalid": []}
                accepted_orders[power_name] = result.get("valid", [])
                invalid_orders[power_name] = result.get("invalid", [])
                submitted_orders[power_name] = accepted_orders[power_name] + invalid_orders[power_name]

            with self.lock:
                human_valid = self.pending_human_orders.get(phase, [])
                accepted_orders[self.human_power] = human_valid
                submitted_orders[self.human_power] = human_valid

                for power_name in POWERS:
                    self.game.set_orders(power_name, accepted_orders.get(power_name, []))

                completed_phase = phase
                self.game.process()
                self._record_completed_phase(completed_phase, submitted_orders)
                self._apply_order_based_relationship_updates(completed_phase, board_state, submitted_orders)
                post_board_state = self.game.get_state()
                self._refresh_visible_relationship_profiles(post_board_state, completed_phase, submitted_orders)

                for power_name, agent in self.agents.items():
                    orders_text = "; ".join(submitted_orders.get(power_name, [])) or "no orders"
                    centers_text = ", ".join(self.game.powers[power_name].centers)
                    agent.add_diary_entry(
                        f"Resolved {completed_phase}. Submitted: {orders_text}. Current centers: {centers_text}.",
                        completed_phase,
                    )

                self.pending_human_orders.pop(completed_phase, None)
                self._save_session_state()
                self._ensure_phase()
                self.status = f"Resolved {completed_phase}; now in {self.game.get_current_phase()}."

            await self._save_checkpoint(completed_phase)
            with self.lock:
                self.busy = False
                return self.snapshot()
        finally:
            with self.lock:
                self.busy = False

    def _record_completed_phase(self, completed_phase: str, submitted_orders: dict[str, list[str]]) -> None:
        phase_history = self.game.get_phase_history()
        if not phase_history:
            return
        last_phase = phase_history[-1]
        if last_phase.name != completed_phase:
            return
        phase_obj = self.game_history._get_phase(completed_phase)
        if not phase_obj:
            return
        phase_obj.submitted_orders_by_power = defaultdict(list, submitted_orders)
        phase_obj.orders_by_power = defaultdict(list, last_phase.orders)
        converted_results = defaultdict(list)
        if last_phase.results:
            for power_name, results in last_phase.results.items():
                converted_results[power_name] = [[str(result)] for result in results]
        phase_obj.results_by_power = converted_results

    def _validate_orders(
        self,
        power_name: str,
        orders: list[str],
        possible_orders: dict[str, list[str]],
        complete_missing: bool = False,
        allow_adjustment_defaults: bool = False,
    ) -> tuple[list[str], list[str]]:
        flat_possible: dict[str, str] = {}
        order_locations: dict[str, str] = {}
        for loc, choices in possible_orders.items():
            for choice in choices:
                upper_choice = choice.upper()
                flat_possible[upper_choice] = choice
                if upper_choice != "WAIVE":
                    order_locations[upper_choice] = loc

        valid: list[str] = []
        invalid: list[str] = []
        used_locations: set[str] = set()
        used_build_sites: set[str] = set()
        for raw_order in orders:
            order = str(raw_order).strip()
            if not order:
                continue
            upper = order.upper()
            if upper == "WAIVE" and "WAIVE" in flat_possible:
                valid.append("WAIVE")
                continue
            if upper not in flat_possible:
                invalid.append(order)
                continue
            normalized = flat_possible[upper]
            loc = order_locations.get(upper) or self._order_location(normalized)
            if loc and loc in used_locations:
                invalid.append(f"Duplicate order for {loc}")
                continue
            build_site = self._build_site(normalized)
            if build_site and build_site in used_build_sites:
                invalid.append(f"Duplicate build site {build_site}")
                continue
            valid.append(normalized)
            if loc:
                used_locations.add(loc)
            if build_site:
                used_build_sites.add(build_site)

        if self.game.phase_type == "A":
            required = abs(self._adjustment_need(power_name))
            if allow_adjustment_defaults:
                valid = self._complete_adjustment_orders(power_name, valid, possible_orders)
            elif len(valid) != required:
                invalid.append(f"Adjustment phase needs exactly {required} order(s); received {len(valid)}")
        elif self.game.phase_type == "R":
            missing_locations = [loc for loc in possible_orders if loc not in used_locations]
            if complete_missing:
                valid.extend(
                    self._fallback_orders(
                        {loc: possible_orders[loc] for loc in missing_locations},
                        power_name,
                        prefer_active=power_name != self.human_power,
                    )
                )
            elif missing_locations:
                invalid.append(f"Retreat phase needs orders for: {', '.join(missing_locations)}")
        elif complete_missing:
            missing_locations = [loc for loc in possible_orders if loc not in used_locations]
            valid.extend(
                self._fallback_orders(
                    {loc: possible_orders[loc] for loc in missing_locations},
                    power_name,
                    prefer_active=power_name != self.human_power,
                )
            )
        return valid, invalid

    def _order_location(self, order: str) -> str | None:
        parts = order.split()
        if len(parts) < 2 or order.upper() == "WAIVE":
            return None
        return parts[1]

    def _build_site(self, order: str) -> str | None:
        parts = order.split()
        if len(parts) == 3 and parts[-1] == "B":
            return parts[1].split("/")[0]
        return None

    def _adjustment_need(self, power_name: str) -> int:
        if self.game.phase_type != "A":
            return 0
        state = self.game.get_state()
        return int(state.get("builds", {}).get(power_name, {}).get("count", 0) or 0)

    def _complete_adjustment_orders(
        self,
        power_name: str,
        valid: list[str],
        possible_orders: dict[str, list[str]],
    ) -> list[str]:
        required = abs(self._adjustment_need(power_name))
        if len(valid) >= required:
            return valid[:required]
        needed = required - len(valid)
        adjustment_need = self._adjustment_need(power_name)
        if adjustment_need > 0 and any("WAIVE" in choices for choices in possible_orders.values()):
            return valid + ["WAIVE"] * needed
        if adjustment_need < 0:
            selected_locations = {
                self._location_key(self._order_location(order))
                for order in valid
                if self._order_location(order)
            }
            disbands = [
                order
                for loc, choices in possible_orders.items()
                if self._location_key(loc) not in selected_locations
                for order in choices
                if order.endswith(" D")
            ]
            return valid + disbands[:needed]
        return valid

    def _location_key(self, location: str | None) -> str:
        return (location or "").split("/")[0].upper()

    def _fallback_orders(
        self,
        possible_orders: dict[str, list[str]],
        power_name: str | None = None,
        prefer_active: bool = False,
    ) -> list[str]:
        phase_type = self.game.phase_type
        if phase_type == "A":
            return self._complete_adjustment_orders(power_name or self.human_power, [], possible_orders)

        fallback = []
        for _, choices in possible_orders.items():
            if not choices:
                continue
            holds = [o for o in choices if o.endswith(" H")]
            disbands = [o for o in choices if o.endswith(" D")]
            if phase_type == "R":
                fallback.append((disbands or choices)[0])
            elif prefer_active:
                moves = [o for o in choices if " - " in o and " S " not in o and " C " not in o]
                supports = [o for o in choices if " S " in o]
                convoys = [o for o in choices if " C " in o]
                fallback.append((moves or supports or convoys or holds or choices)[0])
            else:
                fallback.append((holds or choices)[0])
        return fallback

    def _set_busy(self, status: str) -> None:
        if self.busy:
            raise RuntimeError("The game is already processing a request.")
        self.busy = True
        self.status = status


class HumanPlayHandler(BaseHTTPRequestHandler):
    session: HumanGameSession

    def log_message(self, fmt: str, *args: Any) -> None:
        logger.info("%s - %s", self.address_string(), fmt % args)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._send_file(STATIC_ROOT / "index.html", "text/html; charset=utf-8")
        elif parsed.path == "/static/app.js":
            self._send_file(STATIC_ROOT / "app.js", "application/javascript; charset=utf-8")
        elif parsed.path == "/static/style.css":
            self._send_file(STATIC_ROOT / "style.css", "text/css; charset=utf-8")
        elif parsed.path == "/assets/standard.svg":
            self._send_file(STANDARD_SVG, "image/svg+xml")
        elif parsed.path == "/assets/order-icons.svg":
            self._send_file(STATIC_ROOT / "order-icons.svg", "image/svg+xml")
        elif parsed.path.startswith("/assets/flags/") and parsed.path.endswith(".svg"):
            flag_name = Path(parsed.path).name
            self._send_file(STATIC_ROOT / "flags" / flag_name, "image/svg+xml")
        elif parsed.path == "/api/state":
            self._send_json(self.session.snapshot())
        else:
            self._send_json({"error": "Not found"}, status=404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            payload = self._read_json()
            if parsed.path == "/api/message":
                self._send_json(asyncio.run(self.session.send_message(payload.get("recipient", GLOBAL), payload.get("content", ""))))
            elif parsed.path == "/api/orders":
                self._send_json(self.session.submit_orders(payload.get("orders", [])))
            elif parsed.path == "/api/press":
                rounds = payload.get("rounds")
                self._send_json(asyncio.run(self.session.run_ai_press(rounds=rounds)))
            elif parsed.path == "/api/reply":
                self._send_json(asyncio.run(self.session.ask_agent_reply(payload.get("power", ""))))
            elif parsed.path == "/api/connect-openrouter":
                self._send_json(
                    self.session.connect_openrouter(
                        payload.get("apiKey", ""),
                        payload.get("model", DEFAULT_OPENROUTER_MODEL),
                    )
                )
            elif parsed.path == "/api/resolve":
                self._send_json(asyncio.run(self.session.resolve_phase(payload.get("orders"))))
            else:
                self._send_json({"error": "Not found"}, status=404)
        except Exception as exc:
            logger.exception("Request failed")
            self._send_json({"error": str(exc)}, status=400)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0") or "0")
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def _send_file(self, path: Path, content_type: str) -> None:
        if not path.exists():
            self._send_json({"error": "File not found"}, status=404)
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, data: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(data, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def parse_args() -> Namespace:
    parser = argparse.ArgumentParser(description="Run a local human-vs-LLM Diplomacy browser game.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--human-power", default="FRANCE", choices=POWERS)
    parser.add_argument(
        "--models",
        default="",
        help="One model for all AI powers, six models for non-human powers, or seven models in power order.",
    )
    parser.add_argument("--mock-agents", action="store_true", help="Use deterministic local bots instead of LLM APIs.")
    parser.add_argument("--resume", action="store_true", help="Resume from --run-dir/lmvsgame.json if present.")
    parser.add_argument("--run-dir", default="")
    parser.add_argument("--max-tokens", type=int, default=1200)
    parser.add_argument("--chat-max-tokens", type=int, default=DEFAULT_CHAT_MAX_TOKENS)
    parser.add_argument("--order-max-tokens", type=int, default=DEFAULT_ORDER_MAX_TOKENS)
    parser.add_argument("--max-tokens-per-model", default="")
    parser.add_argument("--num-negotiation-rounds", type=int, default=1)
    parser.add_argument("--prompts-dir", default=None)
    parser.add_argument("--simple-prompts", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--planning-phase", action="store_true", default=False)
    parser.add_argument("--generate-phase-summaries", action="store_true", default=False)
    parser.add_argument("--use-unformatted-prompts", action="store_true", default=False)
    parser.add_argument("--country-specific-prompts", action="store_true", default=False)
    args = parser.parse_args()

    if args.simple_prompts and args.prompts_dir is None:
        args.prompts_dir = str(ROOT / "ai_diplomacy" / "prompts_simple")
    args.prompts_dir_map = parse_prompts_dir_arg(args.prompts_dir)

    config.SIMPLE_PROMPTS = args.simple_prompts
    config.USE_UNFORMATTED_PROMPTS = args.use_unformatted_prompts
    config.COUNTRY_SPECIFIC_PROMPTS = args.country_specific_prompts
    args.max_year = 2100
    args.end_at_phase = ""
    args.resume_from_phase = ""
    args.critical_state_analysis_dir = ""
    return args


def configure_logging(run_dir: Path) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s - %(message)s")
    file_handler = logging.FileHandler(run_dir / "human_play.log", mode="a")
    file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s - %(message)s"))
    logging.getLogger().addHandler(file_handler)


def main() -> None:
    args = parse_args()
    session = HumanGameSession(args)
    configure_logging(session.run_dir)
    HumanPlayHandler.session = session
    server = ThreadingHTTPServer((args.host, args.port), HumanPlayHandler)
    url = f"http://{args.host}:{args.port}"
    logger.info("Human Diplomacy server running at %s", url)
    logger.info("Run directory: %s", session.run_dir)
    print(f"Human Diplomacy server running at {url}")
    print(f"Run directory: {session.run_dir}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
