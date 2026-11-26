"""ModelLink: idempotent App Store Connect setup before a TestFlight build.

1. Registers the bundle ID (Apple Developer → Identifiers) if it is missing.
2. Looks for the App Store Connect app record; if it is missing, tries to create it
   (name, SKU, primary language). Apple may refuse creation through the API; then the
   script prints the exact values to enter in App Store Connect → Apps → "+" and fails.

Auth: APP_STORE_CONNECT_PRIVATE_KEY / _KEY_IDENTIFIER / _ISSUER_ID (set by the Codemagic
App Store Connect integration). Reuses the client from tools/asc_submit.py.

Usage: python3 modellink/tools/asc_setup.py <bundle-id> "<App name>" <sku>
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "tools"))
from asc_submit import ASC, APIError, log  # noqa: E402

NAME_FALLBACKS = ["ModelLink: чертежи и 3D", "ModelLink — CAD и 3D", "ModelLink Viewer"]


def main() -> None:
    bundle_id, name, sku = sys.argv[1], sys.argv[2], sys.argv[3]
    asc = ASC()

    found = asc.get(f"/v1/bundleIds?filter[identifier]={bundle_id}&filter[platform]=IOS")["data"]
    found = [b for b in found if b["attributes"]["identifier"] == bundle_id]
    if found:
        log(f"Bundle ID {bundle_id}: exists ({found[0]['id']})")
    else:
        created = asc.call("POST", "/v1/bundleIds", {"data": {"type": "bundleIds", "attributes": {
            "identifier": bundle_id, "name": "ModelLink", "platform": "IOS"}}})
        log(f"Bundle ID {bundle_id}: registered ({created['data']['id']})")

    apps = asc.get(f"/v1/apps?filter[bundleId]={bundle_id}")["data"]
    if apps:
        log(f"App record: {apps[0]['attributes']['name']} ({apps[0]['id']})")
        return

    last_error = None
    for candidate in [name] + NAME_FALLBACKS:
        try:
            created = asc.call("POST", "/v1/apps", {"data": {"type": "apps", "attributes": {
                "name": candidate, "bundleId": bundle_id, "sku": sku, "primaryLocale": "ru"}}})
            log(f"App record created: {candidate} ({created['data']['id']})")
            return
        except APIError as e:
            last_error = e
            log(f"Creating app '{candidate}' failed: {e}")
            if e.status in (403, 405) or "does not allow" in e.body:
                break
    log("")
    log("App Store Connect did not allow creating the app record through the API.")
    log("Create it once by hand: App Store Connect → Apps → '+' → New App:")
    log(f"  Platform: iOS | Name: {name} | Primary language: Russian | Bundle ID: {bundle_id} | SKU: {sku}")
    log("Then start this workflow again.")
    raise SystemExit(1 if last_error else 0)


if __name__ == "__main__":
    main()
