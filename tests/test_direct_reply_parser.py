from types import SimpleNamespace

from human_play import HumanGameSession


def _session():
    session = HumanGameSession.__new__(HumanGameSession)
    session.human_power = "FRANCE"
    return session


def test_direct_reply_parser_rejects_bare_send_fragment():
    session = _session()

    content = session._parse_direct_reply('{"send":')

    assert content is None
    assert "malformed JSON" in session._direct_reply_format_conflict('{"send":', content)


def test_direct_reply_parser_accepts_valid_json_reply():
    session = _session()

    content = session._parse_direct_reply('{"send": true, "content": "I can support F ENG - NTH with F HEL."}')

    assert content == "I can support F ENG - NTH with F HEL."
    assert session._direct_reply_format_conflict('{"send": true, "content": "I can support F ENG - NTH with F HEL."}', content) is None


def test_direct_reply_parser_accepts_content_from_truncated_json():
    session = _session()

    raw = '{"send": true, "content": "I can support F ENG - NTH with F HEL."'
    content = session._parse_direct_reply(raw)

    assert content == "I can support F ENG - NTH with F HEL."
    assert session._direct_reply_format_conflict(raw, content) is None


def test_malformed_agent_reply_message_is_hidden():
    session = _session()

    assert session._is_malformed_agent_reply_message("GERMANY", "FRANCE", '{"send":')
    assert not session._is_malformed_agent_reply_message("FRANCE", "GERMANY", '{"send":')
    assert not session._is_malformed_agent_reply_message("GERMANY", "FRANCE", "I can support you.")


def test_drop_malformed_agent_reply_messages_from_history():
    session = _session()
    phase = SimpleNamespace(
        messages=[
            SimpleNamespace(sender="GERMANY", recipient="FRANCE", content='{"send":'),
            SimpleNamespace(sender="GERMANY", recipient="FRANCE", content="I can support you."),
            SimpleNamespace(sender="FRANCE", recipient="GERMANY", content='{"send":'),
        ]
    )
    session.game_history = SimpleNamespace(phases=[phase])

    session._drop_malformed_agent_reply_messages()

    assert [message.content for message in phase.messages] == ["I can support you.", '{"send":']
