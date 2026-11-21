#!/usr/bin/env python3
"""Read-only: App Store status of every app in the App Store Connect account."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from asc_submit import ASC  # noqa: E402

asc = ASC()
for app in asc.all("/v1/apps?limit=200"):
    a = app["attributes"]
    versions = asc.all(f"/v1/apps/{app['id']}/appStoreVersions?filter[platform]=IOS&limit=50")
    states = ", ".join(f"{v['attributes']['versionString']}={v['attributes'].get('appVersionState') or v['attributes'].get('appStoreState')}" for v in versions) or "no versions"
    subs = asc.get(f"/v1/reviewSubmissions?filter[app]={app['id']}&limit=20", ok_missing=True) or {}
    sub_states = ", ".join(s["attributes"].get("state", "?") for s in subs.get("data", [])) or "none"
    print(f"STATUS | {a['name']} | {a['bundleId']} | versions: {states} | reviewSubmissions: {sub_states}", flush=True)
