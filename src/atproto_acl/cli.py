"""Local CLI. Preview is the default and fixture data can never enforce."""
from __future__ import annotations

import argparse
import html
import json
import os
from pathlib import Path
import sys

from . import __version__
from .adapters import PrivateMuteAdapter
from .model import digest, utcnow
from .network import APPVIEW, Client, NetworkError, Session, resolve
from .policy import PolicyError, compile_policy
from .runtime import build_receipt, execute, prepare
from .store import StateError, Store
from .receipts import set_completeness


def parser():
    p = argparse.ArgumentParser(description="Personal ATProto moderation-policy runtime; preview by default")
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="command", required=True)
    for name in ("validate", "catalog", "preview", "sync", "explain", "override", "rebind", "resume"):
        command = sub.add_parser(name)
        command.add_argument("--policy", required=True, type=Path)
        command.add_argument("--state", type=Path)
        command.add_argument("--format", choices=("text", "json", "html"), default="text")
        command.add_argument("--out", type=Path)
        command.add_argument("--fixture", type=Path, help="offline preview input; never usable for enforcement")
        command.add_argument("--max-requests", type=int, default=1000)
        command.add_argument("--max-pages", type=int, default=20)
        if name in ("preview", "sync"):
            command.add_argument("--authenticate", action="store_true", help="read your private moderation state")
            command.add_argument("--app-password-file", type=Path)
        if name == "preview":
            command.add_argument("--now", help="explicit evaluation time for replay")
        if name == "sync":
            mode = command.add_mutually_exclusive_group()
            mode.add_argument("--apply", action="store_true")
            mode.add_argument("--release", metavar="PROPOSAL_ID")
            command.add_argument("--did", action="append", default=[])
            command.add_argument("--max-actions", type=int, default=100)
        if name == "explain":
            command.add_argument("--receipt", required=True)
            command.add_argument("--did", required=True)
        if name == "override":
            command.add_argument("operation", choices=("add", "remove", "list"))
            command.add_argument("--kind", choices=("exempt", "allow", "keep-muted"))
            command.add_argument("--actor")
        if name == "rebind":
            command.add_argument("--actor", required=True)
            command.add_argument("--from-did", required=True)
            command.add_argument("--to-did", required=True)
        if name == "resume":
            command.add_argument("--did", required=True)
            command.add_argument("--acknowledge-unknown-history", action="store_true", required=True)
    return p


def render(data, format):
    if format == "json":
        return json.dumps(data, indent=2, sort_keys=True)
    if format == "html":
        return "<!doctype html><html lang=en><meta charset=utf-8><title>atproto-acl preview</title>" \
            "<style>body{font:16px system-ui;max-width:1000px;margin:3rem auto;padding:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>" \
            "<h1>atproto-acl</h1><p>Observed properties matched a user-authored policy. This report makes no quality or intent assessment.</p><pre>" \
            + html.escape(json.dumps(data, indent=2, sort_keys=True)) + "</pre></html>"
    if "rows" not in data:
        return json.dumps(data, indent=2, sort_keys=True)
    lines = [f"atproto-acl  {data['mode']}  {data['account']}", f"receipt: {data['id']}",
             f"evaluated: {len(data['rows'])} accounts; counts describe this candidate set", ""]
    lines.insert(2, f"complete: {str(data.get('complete', False)).lower()}" +
                 (" (" + ", ".join(data.get("incomplete_reasons", ["legacy_receipt"])) + ")"
                  if not data.get("complete", False) else ""))
    for row in data["rows"]:
        lines.append(f"{row['subject']}  {row['desired']}  {row['action']}\n  {row['reason']}")
        if row.get("disposition_reasons"):
            lines.append("  policy: " + ", ".join(row["disposition_reasons"]))
    if data.get("executions"):
        lines += ["", json.dumps(data["executions"], indent=2)]
    return "\n".join(lines)


def emit(data, args):
    output = render(data, args.format) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(output)
    else:
        print(output, end="")


def main(argv=None):
    args = parser().parse_args(argv)
    store = None
    try:
        if args.max_requests <= 0 or args.max_pages <= 0 or getattr(args, "max_actions", 1) <= 0:
            raise StateError("request, page, and action budgets must be positive")
        policy = compile_policy(args.policy.read_bytes().decode("utf-8"))
        if args.command == "validate":
            emit({"valid": True, "policy_hash": policy.policy_hash, "policy_source_hash": policy.source_hash}, args)
            return 0
        write = args.command == "sync" and (args.apply or args.release)
        if args.fixture and (write or getattr(args, "authenticate", False)):
            raise StateError("fixtures cannot authenticate or enforce")
        if args.command == "sync" and args.did and not args.release:
            raise StateError("--did is only valid with --release")
        fixture = json.loads(args.fixture.read_text()) if args.fixture else None
        client = Client(max_requests=args.max_requests)
        if args.command == "catalog":
            if fixture:
                emit({"providers": policy.config["providers"], "fixture": True}, args)
            else:
                dids = sorted({x["did"] for x in policy.config["providers"].values()})
                emit(client.get(APPVIEW, "app.bsky.labeler.getServices", {"dids": dids, "detailed": "true"}), args)
            return 0
        configured = policy.config["account"]
        account = fixture["account"] if fixture else resolve(client, configured)
        if fixture and configured != account and fixture.get("identities", {}).get(configured) != account:
            raise StateError("fixture account does not match configured identity")
        mode = "fixture" if fixture is not None else "live"
        state_path = args.state or Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "atproto-acl" / (digest(configured)[:24] + "." + mode + ".db")
        store = Store(state_path, account, mode)
        with store.lock():
            store.pin(configured, account)
            if args.command == "explain":
                data = store.receipt(args.receipt)
                data["rows"] = [r for r in data["rows"] if r["subject"] == args.did]
                emit(data, args)
                return 0
            if args.command == "override":
                if args.operation != "list":
                    if not args.actor or not args.kind:
                        raise StateError("override add/remove requires --actor and --kind")
                    did = resolve(client, args.actor)
                    store.pin(args.actor, did)
                    store.set_override(did, args.kind.replace("-", "_"), args.operation == "add")
                emit({k: sorted(v) for k, v in store.overrides().items()}, args)
                return 0
            if args.command == "rebind":
                if args.actor == configured:
                    raise StateError("account migration requires a separate account state; rebind is for subject identities")
                actual = resolve(client, args.actor)
                if actual != args.to_did:
                    raise StateError("new DID does not match current verified identity")
                store.rebind(args.actor, args.from_did, actual)
                emit(store.identities(), args)
                return 0
            if args.command == "resume":
                ledger = store.ledgers().get(args.did, {})
                if ledger.get("status") not in ("suspended", "unresolved"):
                    raise StateError("resume requires a suspended or unresolved subject")
                store.ledger(args.did, "untracked", {"reason": "user acknowledged unknown history; no ownership adopted"})
                store.audit("resume", {"subject": args.did, "ownership": "unproven"})
                emit({"subject": args.did, "status": "untracked", "ownership": "unproven"}, args)
                return 0
            session = None
            if write or args.authenticate:
                if args.app_password_file:
                    password = args.app_password_file.read_text().strip()
                else:
                    password = os.environ.get("ATPROTO_ACL_APP_PASSWORD", "")
                if not password:
                    raise StateError("provide ATPROTO_ACL_APP_PASSWORD or --app-password-file")
                session = Session(client, account, password)
            prepared = prepare(policy, store, client, session, fixture, args.max_pages)
            now = getattr(args, "now", None) or utcnow()
            receipt = build_receipt(policy, store, *prepared, now)
            receipt["fixture"] = fixture is not None
            receipt["requests"] = client.requests
            if write:
                previous = store.receipt(args.release) if args.release else None
                try:
                    execute(receipt, store, PrivateMuteAdapter(session), previous, args.did, args.max_actions)
                except StateError as exc:
                    receipt["mode"], receipt["refusal"] = "refused", str(exc)
                    set_completeness(receipt, execution_complete=False)
                    store.save_receipt(receipt)
                    emit(receipt, args)
                    return 2
            else:
                store.save_receipt(receipt)
            emit(receipt, args)
            return 3 if any(x["status"] != "confirmed" for x in receipt["executions"]) else 0
    except (PolicyError, StateError, NetworkError) as exc:
        emit({"schema": 1, "mode": "refused", "complete": False, "reason": str(exc)}, args)
        return 2
    except (OSError, ValueError, KeyError, TypeError) as exc:
        # Avoid printing arbitrary file contents, provider bodies, or credentials.
        emit({"schema": 1, "mode": "refused", "complete": False, "reason": f"invalid input or unavailable local resource ({type(exc).__name__})"}, args)
        return 2
    finally:
        if store:
            store.close()


if __name__ == "__main__":
    sys.exit(main())
