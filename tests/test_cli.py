import json
from pathlib import Path

import pytest

from atproto_acl.cli import main, render
from atproto_acl.model import digest

ROOT = Path(__file__).resolve().parents[1]


def test_offline_demo_and_replay(tmp_path, capsys):
    args = ["preview", "--policy", str(ROOT / "examples/demo.yaml"),
            "--fixture", str(ROOT / "examples/demo.json"), "--state", str(tmp_path / "demo.db"),
            "--now", "2026-09-08T12:00:00Z", "--format", "json"]
    assert main(args) == 0
    first = json.loads(capsys.readouterr().out)
    assert main(args) == 0
    second = json.loads(capsys.readouterr().out)
    assert first["rows"] == second["rows"]
    rows = {r["subject"]: r for r in first["rows"]}
    assert rows["did:plc:alice"]["action"] == "mute"
    assert rows["did:plc:bob"]["evaluation"]["basis"] == "allow_rule"
    assert rows["did:plc:carol"]["desired"] == "indeterminate"
    assert first["executions"] == []
    assert first["complete"] is False
    assert first["completeness"]["discovery"] is True
    assert "evidence" in first["incomplete_reasons"]
    assert first["decision_context_hash"] == second["decision_context_hash"]
    assert main(["explain", "--policy", str(ROOT / "examples/demo.yaml"),
        "--fixture", str(ROOT / "examples/demo.json"), "--state", str(tmp_path / "demo.db"),
        "--receipt", first["id"], "--did", "did:plc:alice", "--format", "json"]) == 0
    assert len(json.loads(capsys.readouterr().out)["rows"]) == 1


@pytest.mark.parametrize("flags", [["--apply"], ["--release", "proposal", "--did", "did:plc:alice"], ["--authenticate"]])
def test_fixtures_cannot_authenticate_or_enforce(tmp_path, capsys, flags):
    assert main(["sync", "--policy", str(ROOT / "examples/demo.yaml"),
                 "--fixture", str(ROOT / "examples/demo.json"), "--state", str(tmp_path / "x.db"), *flags]) == 2
    assert "fixtures cannot" in capsys.readouterr().out
    assert not (tmp_path / "x.db").exists()


def test_html_report_escapes_evidence():
    output = render({"evidence": "<script>alert('x')</script>"}, "html")
    assert "<script>" not in output and "&lt;script&gt;" in output


def test_example_validates_without_network(capsys):
    assert main(["validate", "--policy", str(ROOT / "examples/poasters-quarantine.yaml")]) == 0
    assert '"valid": true' in capsys.readouterr().out


def test_evaluator_capability_boundary():
    import ast
    tree = ast.parse((ROOT / "src/atproto_acl/policy.py").read_text())
    imports = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
    assert not imports & {"network", "adapters", "runtime", "store", "socket", "urllib.request"}
