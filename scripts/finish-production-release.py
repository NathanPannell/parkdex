"""Finish an authorized production dispatch using the existing verified alias helpers."""
import importlib.util
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("kip_delivery", Path(__file__).with_name("kip-delivery.py"))
delivery = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = delivery
spec.loader.exec_module(delivery)
config = delivery.load_config()
sha = os.environ["GITHUB_SHA"]
delivery.verify_git_sha(sha, production_only=True, clean=False)
project_id = delivery.release_project_id(config, "production")
deadline = time.time() + 600
while time.time() < deadline:
    deployments = delivery.list_vercel_deployments(config, project_id, int((time.time() - 3600) * 1000), target="production")
    matches = [item for item in deployments
               if delivery.deployment_meta(item).get("githubCommitSha") == sha
               and delivery.deployment_meta(item).get("kipEnvironment") == "production"]
    if len(matches) > 1:
        raise delivery.DeliveryError("Multiple deployments match the release; manual recovery required.")
    if matches:
        item = matches[0]
        status = item.get("readyState") or item.get("state")
        if status in ("ERROR", "CANCELED"):
            raise delivery.DeliveryError("Production deployment failed: " + status)
        if status == "READY":
            args = SimpleNamespace(sha=sha, deployment_id=item.get("uid") or item.get("id"), apply=True)
            delivery.assign_main(args)
            delivery.verify_main(args)
            break
    time.sleep(10)
else:
    raise delivery.DeliveryError("Timed out waiting for the exact production deployment.")
