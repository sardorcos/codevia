"""ModelLink: after an upload, wait for TestFlight processing, then give internal testers access.

1. Waits until the newest build of the app is VALID (processing finished); marks export
   compliance (no non-exempt encryption) if App Store Connect still asks for it.
2. Creates the internal beta group "ModelLink Internal" with access to all builds (idempotent).
3. Adds the account holder (and, with --all-users, every App Store Connect user) to the group.

Auth: APP_STORE_CONNECT_* variables of the Codemagic integration (client from tools/asc_submit.py).
Usage: python3 modellink/tools/asc_testflight.py <bundle-id> [--all-users] [--timeout-min 45]
"""
import argparse
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "tools"))
from asc_submit import ASC, APIError, log  # noqa: E402

GROUP_NAME = "ModelLink Internal"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("bundle_id")
    p.add_argument("--all-users", action="store_true")
    p.add_argument("--timeout-min", type=int, default=45)
    p.add_argument("--notes", help="JSON with betaDescription / whatsNew per locale")
    args = p.parse_args()
    asc = ASC()

    apps = asc.get(f"/v1/apps?filter[bundleId]={args.bundle_id}")["data"]
    if not apps:
        raise SystemExit(f"No App Store Connect app for {args.bundle_id}")
    app = apps[0]
    log(f"App: {app['attributes']['name']} ({app['id']})")

    # 1. Processing
    deadline = time.time() + args.timeout_min * 60
    build = None
    while True:
        builds = asc.get(f"/v1/builds?filter[app]={app['id']}&sort=-uploadedDate&limit=1")["data"]
        if builds:
            build = builds[0]
            a = build["attributes"]
            log(f"Build {a['version']}: processing={a['processingState']} expired={a.get('expired')}")
            if a["processingState"] == "VALID":
                break
            if a["processingState"] in ("FAILED", "INVALID"):
                raise SystemExit("App Store Connect rejected the build during processing")
        else:
            log("No builds yet")
        if time.time() > deadline:
            raise SystemExit("Processing did not finish in time; run this workflow again later")
        time.sleep(60)

    if build["attributes"].get("usesNonExemptEncryption") is None:
        try:
            asc.call("PATCH", f"/v1/builds/{build['id']}", {"data": {"type": "builds", "id": build["id"],
                     "attributes": {"usesNonExemptEncryption": False}}})
            log("Export compliance: no non-exempt encryption")
        except APIError as e:
            log(f"Export compliance not set: {e}")

    # 1b. TestFlight texts: beta app description and "What to Test" for this build
    if args.notes:
        import json
        notes = json.loads(pathlib.Path(args.notes).read_text())
        have = {l["attributes"]["locale"]: l for l in asc.get(f"/v1/apps/{app['id']}/betaAppLocalizations?limit=50")["data"]}
        for locale, text in notes.get("betaDescription", {}).items():
            try:
                if locale in have:
                    asc.call("PATCH", f"/v1/betaAppLocalizations/{have[locale]['id']}", {"data": {"type": "betaAppLocalizations", "id": have[locale]["id"], "attributes": {"description": text}}})
                else:
                    asc.call("POST", "/v1/betaAppLocalizations", {"data": {"type": "betaAppLocalizations", "attributes": {"locale": locale, "description": text},
                             "relationships": {"app": {"data": {"type": "apps", "id": app["id"]}}}}})
                log(f"Beta description [{locale}] set")
            except APIError as e:
                log(f"Beta description [{locale}] not set: {e}")
        have = {l["attributes"]["locale"]: l for l in asc.get(f"/v1/builds/{build['id']}/betaBuildLocalizations?limit=50")["data"]}
        for locale, text in notes.get("whatsNew", {}).items():
            try:
                if locale in have:
                    asc.call("PATCH", f"/v1/betaBuildLocalizations/{have[locale]['id']}", {"data": {"type": "betaBuildLocalizations", "id": have[locale]["id"], "attributes": {"whatsNew": text}}})
                else:
                    asc.call("POST", "/v1/betaBuildLocalizations", {"data": {"type": "betaBuildLocalizations", "attributes": {"locale": locale, "whatsNew": text},
                             "relationships": {"build": {"data": {"type": "builds", "id": build["id"]}}}}})
                log(f"What to Test [{locale}] set")
            except APIError as e:
                log(f"What to Test [{locale}] not set: {e}")

    # 2. Internal group
    groups = asc.get(f"/v1/apps/{app['id']}/betaGroups?limit=200")["data"]
    group = next((g for g in groups if g["attributes"]["name"] == GROUP_NAME), None)
    if group:
        log(f"Group '{GROUP_NAME}': exists ({group['id']})")
    else:
        group = asc.call("POST", "/v1/betaGroups", {"data": {"type": "betaGroups",
            "attributes": {"name": GROUP_NAME, "isInternalGroup": True, "hasAccessToAllBuilds": True},
            "relationships": {"app": {"data": {"type": "apps", "id": app["id"]}}}}})["data"]
        log(f"Group '{GROUP_NAME}': created ({group['id']})")
    if not group["attributes"].get("hasAccessToAllBuilds"):
        asc.call("POST", f"/v1/betaGroups/{group['id']}/relationships/builds",
                 {"data": [{"type": "builds", "id": build["id"]}]})
        log("Build added to the group")

    # 3. Testers (internal testers must be App Store Connect users)
    users = asc.get("/v1/users?limit=200")["data"]
    chosen = users if args.all_users else [u for u in users if "ACCOUNT_HOLDER" in u["attributes"].get("roles", [])]
    if not chosen:
        chosen = [u for u in users if "ADMIN" in u["attributes"].get("roles", [])][:1]
    current = {t["attributes"].get("email", "").lower()
               for t in asc.get(f"/v1/betaGroups/{group['id']}/betaTesters?limit=200")["data"]}
    for u in chosen:
        ua = u["attributes"]
        email = ua.get("username") or ua.get("email")
        who = f"{ua.get('firstName', '')} {ua.get('lastName', '')}".strip() or "user"
        if not email:
            continue
        if email.lower() in current:
            log(f"Tester {who}: already in the group")
            continue
        try:
            asc.call("POST", "/v1/betaTesters", {"data": {"type": "betaTesters",
                "attributes": {"email": email, "firstName": ua.get("firstName") or "", "lastName": ua.get("lastName") or ""},
                "relationships": {"betaGroups": {"data": [{"type": "betaGroups", "id": group["id"]}]}}}})
            log(f"Tester {who} ({', '.join(ua.get('roles', []))}): added")
        except APIError as e:
            if e.status == 409:
                existing = asc.get(f"/v1/betaTesters?filter[email]={email}")["data"]
                if existing:
                    asc.call("POST", f"/v1/betaGroups/{group['id']}/relationships/betaTesters",
                             {"data": [{"type": "betaTesters", "id": existing[0]["id"]}]})
                    log(f"Tester {who}: existing tester linked to the group")
                    continue
            log(f"Tester {who}: could not add: {e}")
    log("Done. Testers get the build in the TestFlight app (invitation email for first-time testers).")


if __name__ == "__main__":
    main()
