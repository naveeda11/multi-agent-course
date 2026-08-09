#!/usr/bin/env python3
import argparse
from decimal import Decimal, InvalidOperation
import hashlib
from io import BytesIO
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
from urllib.parse import parse_qs, quote, unquote, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{3,200}$")
ALLOWED_IMAGE_HOSTS = {"images.unsplash.com"}
SYMBOL_CURRENCIES = {
    "$": {"usd", "cad", "aud", "nzd"},
    "€": {"eur"},
    "£": {"gbp"},
}
FORBIDDEN_MARKETING = re.compile(
    r"\b(?:lorem ipsum|todo|tbd|placeholder)\b|testimonial|five[- ]star|customers love us",
    re.I,
)


class ImageSourceParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.sources = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "img":
            return
        attributes = dict(attrs)
        if attributes.get("src"):
            self.sources.append(attributes["src"])


def load_exact_env(name):
    value = os.environ.get(name)
    if value:
        return value
    env_path = ROOT / ".env"
    if not env_path.exists():
        return None
    for line in env_path.read_text(encoding="utf-8").splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'") or None
    return None


def postgres_env(database_url):
    parsed = urlparse(database_url)
    query = parse_qs(parsed.query)
    environment = os.environ.copy()
    environment.update(
        {
            "PGHOST": parsed.hostname or "",
            "PGPORT": str(parsed.port or 5432),
            "PGDATABASE": parsed.path.lstrip("/"),
            "PGUSER": unquote(parsed.username or ""),
            "PGPASSWORD": unquote(parsed.password or ""),
            "PGSSLMODE": query.get("sslmode", ["verify-full"])[0],
            "PGCONNECT_TIMEOUT": "10",
        }
    )
    return environment


def query_json(database_url, sql):
    psql = shutil.which("psql")
    if not psql:
        raise RuntimeError("psql is required for product evaluation")
    result = subprocess.run(
        [psql, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql],
        cwd=ROOT,
        env=postgres_env(database_url),
        check=True,
        text=True,
        capture_output=True,
        timeout=30,
    )
    output = result.stdout.strip()
    return json.loads(output) if output else None


def fetch(url):
    request = Request(url, headers={"user-agent": "EPYHIA-product-eval/1"})
    with urlopen(request, timeout=15) as response:
        return response.status, response.read().decode("utf-8", errors="replace")


def verify_images(html):
    parser = ImageSourceParser()
    parser.feed(html)
    if not parser.sources:
        return False, "no image sources"
    for source in parser.sources:
        parsed = urlparse(source)
        if parsed.scheme != "https" or (parsed.hostname or "").lower() not in ALLOWED_IMAGE_HOSTS:
            return False, f"unapproved image host: {parsed.hostname or 'missing'}"
        try:
            request = Request(source, headers={"user-agent": "EPYHIA-product-eval/1"})
            with urlopen(request, timeout=10) as response:
                content_type = response.headers.get("content-type", "").lower()
                response.read(1)
                if response.status != 200 or not content_type.startswith("image/"):
                    return False, f"invalid image response: HTTP {response.status} {content_type}"
        except Exception as error:
            return False, f"image verification failed: {type(error).__name__}"
    return True, f"verified {len(parser.sources)} allow-listed image response(s)"


def verify_marketing_copy(artifacts, catalog):
    text_artifacts = [
        item for item in artifacts
        if item.get("artifact_type") not in ("VIDEO_LANDSCAPE", "VIDEO_VERTICAL")
    ]
    if any(not str(item.get("text_content") or "").strip() for item in text_artifacts):
        return False, "one or more text artifacts are empty"
    combined = "\n".join(str(item["text_content"]) for item in text_artifacts)
    if FORBIDDEN_MARKETING.search(combined):
        return False, "copy contains filler or fabricated social proof"
    if not catalog:
        return False, "catalog is missing"
    business_name = str(catalog[0].get("business_name") or "")
    if not business_name or business_name.lower() not in combined.lower():
        return False, "copy does not identify the persisted business"
    if not any(str(item["name"]).lower() in combined.lower() for item in catalog):
        return False, "copy does not reference a persisted catalog item"

    allowed = {
        (str(item["currency"]).lower(), int(item["day_rate_cents"]))
        for item in catalog
    }
    claims = []
    claims.extend(("symbol", match.groups()) for match in re.finditer(
        r"([$€£])\s*(\d+(?:[.,]\d{2})?)", combined
    ))
    claims.extend(("amount-code", match.groups()) for match in re.finditer(
        r"(\d+[.,]\d{2})\s*([A-Za-z]{3})\b", combined
    ))
    claims.extend(("code-amount", match.groups()) for match in re.finditer(
        r"\b([A-Za-z]{3})\s*(\d+[.,]\d{2})", combined
    ))
    for kind, groups in claims:
        if kind == "symbol":
            currencies = SYMBOL_CURRENCIES[groups[0]]
            amount = groups[1]
        elif kind == "amount-code":
            amount, currency = groups
            currencies = {currency.lower()}
        else:
            currency, amount = groups
            currencies = {currency.lower()}
        try:
            cents = int(Decimal(amount.replace(",", ".")) * 100)
        except (InvalidOperation, ValueError):
            return False, "copy contains an invalid currency amount"
        if not any((currency, cents) in allowed for currency in currencies):
            return False, "copy contains a price absent from the persisted catalog"
    return True, f"checked {len(text_artifacts)} text artifacts and {len(claims)} price claims"


def verify_r2_videos(videos):
    if len(videos) != 2:
        return False, f"expected two video artifacts, found {len(videos)}"
    objects = []
    for video in videos:
        feedback = video.get("review_feedback") or {}
        if not isinstance(feedback, dict):
            return False, "video content-hash evidence is malformed"
        objects.append(
            {
                "key": video.get("r2_object_key"),
                "contentHash": feedback.get("contentHash"),
                "mimeType": video.get("mime_type"),
            }
        )
    required_names = [
        "CLOUDFLARE_R2_S3_URL",
        "CLOUDFLARE_R2_ACCESS_KEY_ID",
        "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
        "R2_BUCKET",
    ]
    values = {name: load_exact_env(name) for name in required_names}
    missing = [name for name, value in values.items() if not value]
    if missing:
        return False, f"missing R2 evaluation configuration: {', '.join(missing)}"
    node = shutil.which("node")
    if not node:
        return False, "node is required for R2 evidence verification"
    environment = {"PATH": os.environ.get("PATH", ""), **values}
    try:
        result = subprocess.run(
            [node, str(ROOT / "eval" / "r2-evidence.js")],
            cwd=ROOT,
            env=environment,
            input=json.dumps(objects),
            text=True,
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, "R2 evidence check could not complete"
    if result.returncode != 0:
        return False, result.stderr.strip()[:300] or "R2 evidence check failed"
    try:
        evidence = json.loads(result.stdout)
    except json.JSONDecodeError:
        return False, "R2 evidence check returned invalid output"
    return evidence.get("verified") == 2, "verified two content-hash-bound R2 video objects"


def verify_stripe_session(order, run):
    secret = load_exact_env("STRIPE_SANDBOX_SECRET_KEY")
    if not secret or not secret.startswith("sk_test_"):
        return False, "Stripe sandbox secret is missing or not test mode"
    session_id = str(order.get("stripe_checkout_session_id") or "")
    if not re.fullmatch(r"cs_test_[A-Za-z0-9_]+", session_id):
        return False, "order does not reference a Stripe test Checkout Session"
    request = Request(
        f"https://api.stripe.com/v1/checkout/sessions/{quote(session_id, safe='')}",
        headers={
            "authorization": f"Bearer {secret}",
            "user-agent": "EPYHIA-product-eval/1",
        },
    )
    try:
        with urlopen(request, timeout=15) as response:
            session = json.loads(response.read().decode("utf-8"))
    except Exception as error:
        return False, f"Stripe session retrieval failed: {type(error).__name__}"
    metadata = session.get("metadata") or {}
    expected = (
        session.get("id") == session_id
        and session.get("livemode") is False
        and session.get("mode") == "payment"
        and session.get("payment_status") == "paid"
        and session.get("status") == "complete"
        and int(session.get("amount_total") or 0) == int(order.get("amount_cents") or 0)
        and str(session.get("currency") or "").lower() == str(order.get("currency") or "").lower()
        and metadata.get("reservation_id") == order.get("reservation_id")
        and metadata.get("tenant_id") == (run or {}).get("tenant_id")
    )
    return expected, "retrieved matching paid Stripe test Checkout Session"


def verify_auth0_protection(agency_url):
    values = {
        name: load_exact_env(name)
        for name in ("ISSUER_BASE_URL", "CLIENT_ID")
    }
    missing = [name for name, value in values.items() if not value]
    if missing:
        return False, f"missing Auth0 evaluation configuration: {', '.join(missing)}"
    node = shutil.which("node")
    if not node:
        return False, "node is required for Auth0 evidence verification"
    environment = {"PATH": os.environ.get("PATH", ""), **values}
    try:
        result = subprocess.run(
            [node, str(ROOT / "eval" / "auth0-evidence.js")],
            cwd=ROOT,
            env=environment,
            input=json.dumps({"agencyUrl": agency_url}),
            text=True,
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, "Auth0 protection check could not complete"
    if result.returncode != 0:
        return False, result.stderr.strip()[:300] or "Auth0 protection check failed"
    try:
        evidence = json.loads(result.stdout)
    except json.JSONDecodeError:
        return False, "Auth0 protection check returned invalid output"
    return (
        evidence.get("verified") is True,
        f"unauthenticated /admin redirected through Auth0 to {evidence.get('callback', 'missing')}",
    )


def check_result(check, passed, evidence):
    return {
        **check,
        "passed": bool(passed),
        "earned": check["points"] if passed else 0,
        "evidence": evidence,
    }


def verify_clean_clone():
    repository_root = Path(
        subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=ROOT,
            check=True,
            text=True,
            capture_output=True,
        ).stdout.strip()
    )
    assignment_path = ROOT.relative_to(repository_root).as_posix()
    archive = subprocess.run(
        ["git", "archive", "--format=tar", "HEAD", assignment_path],
        cwd=repository_root,
        check=True,
        capture_output=True,
    ).stdout
    with tempfile.TemporaryDirectory(prefix="epyhia-clean-clone-") as temporary:
        clone_root = Path(temporary)
        with tarfile.open(fileobj=BytesIO(archive), mode="r:") as bundle:
            for member in bundle.getmembers():
                if member.issym() or member.islnk():
                    return False, "committed assignment archive contains a symbolic link"
                target = (clone_root / member.name).resolve()
                if clone_root.resolve() not in target.parents and target != clone_root.resolve():
                    return False, "committed archive contains an unsafe path"
            bundle.extractall(clone_root, filter="data")
        assignment_root = clone_root / assignment_path
        clean_environment = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": os.environ.get("HOME", ""),
            "CI": "1",
        }
        try:
            install = subprocess.run(
                ["npm", "ci", "--ignore-scripts"],
                cwd=assignment_root,
                env=clean_environment,
                text=True,
                capture_output=True,
                timeout=180,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False, "npm ci could not complete in the committed archive"
        if install.returncode != 0:
            return False, "npm ci failed in an archive of committed files"
        try:
            tests = subprocess.run(
                ["npm", "test"],
                cwd=assignment_root,
                env=clean_environment,
                text=True,
                capture_output=True,
                timeout=60,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False, "tests could not complete in the committed archive"
        if tests.returncode != 0:
            return False, "tests failed in an archive of committed files"
    return True, "npm ci and tests passed from an isolated archive of HEAD"


def main():
    parser = argparse.ArgumentParser(description="Evaluate a deployed EPYHIA run")
    parser.add_argument("--agency-url", required=True)
    parser.add_argument("--business-url", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--reservation-id", required=True)
    parser.add_argument("--output", default=str(ROOT / "PRODUCT_EVAL.md"))
    args = parser.parse_args()
    for label, value in (("run-id", args.run_id), ("reservation-id", args.reservation_id)):
        if not SAFE_ID.fullmatch(value):
            raise SystemExit(f"{label} contains unsafe characters")
    database_url = load_exact_env("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is required")
    rubric = json.loads((ROOT / "eval" / "rubric.json").read_text(encoding="utf-8"))
    checks = {item["id"]: item for item in rubric["checks"]}

    agency_status, agency_body = fetch(f"{args.agency_url.rstrip('/')}/health")
    auth0_protected, auth0_evidence = verify_auth0_protection(args.agency_url)
    business_status, business_html = fetch(args.business_url)
    images_verified, image_evidence = verify_images(business_html)
    state = query_json(
        database_url,
        f"""
        SELECT json_build_object(
          'run', (SELECT row_to_json(r) FROM (
            SELECT id, tenant_id, status, brand_document_id,
              approved_budget_microdollars
            FROM runs WHERE id = '{args.run_id}'
          ) r),
          'tasks', (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
            SELECT task_type, status, output_ref FROM tasks
            WHERE run_id = '{args.run_id}' ORDER BY task_type
          ) t),
          'agent_calls', (SELECT COALESCE(json_agg(c), '[]'::json) FROM (
            SELECT agent_name, model_id, model_tier, status, cost_microdollars
            FROM agent_calls WHERE run_id = '{args.run_id}' ORDER BY started_at
          ) c),
          'actions', (SELECT COALESCE(json_agg(a), '[]'::json) FROM (
            SELECT action_type, mode, approval_status, approved_by, approved_at,
              payload_hash, status, provider_cost_microdollars, executed_at
            FROM actions WHERE run_id = '{args.run_id}' ORDER BY created_at
          ) a),
          'artifacts', (SELECT COALESCE(json_agg(m), '[]'::json) FROM (
            SELECT brand_document_id, artifact_type, sequence_number, self_review_status,
              grounding_check_status, approval_status, text_content, channel,
              r2_object_key, mime_type,
              CASE
                WHEN artifact_type IN ('VIDEO_LANDSCAPE', 'VIDEO_VERTICAL')
                  THEN review_feedback::jsonb
                ELSE NULL
              END AS review_feedback
            FROM marketing_artifacts WHERE run_id = '{args.run_id}'
            ORDER BY artifact_type, sequence_number
          ) m),
          'site_artifacts', (SELECT COALESCE(json_agg(s), '[]'::json) FROM (
            SELECT brand_document_id, revision_number, content_hash, validation_status
            FROM site_artifacts WHERE run_id = '{args.run_id}'
            ORDER BY revision_number
          ) s),
          'catalog', (SELECT COALESCE(json_agg(i), '[]'::json) FROM (
            SELECT rental_items.name, rental_items.day_rate_cents,
              rental_items.currency, tenants.business_name, tenants.business_email,
              tenants.business_phone, tenants.business_address
            FROM rental_items JOIN tenants ON tenants.id = rental_items.tenant_id
            JOIN runs ON runs.tenant_id = tenants.id
            WHERE runs.id = '{args.run_id}' AND rental_items.active = true
            ORDER BY rental_items.item_key
          ) i),
          'order', (SELECT row_to_json(o) FROM (
            SELECT orders.id, orders.status, orders.amount_cents, orders.currency,
              orders.stripe_checkout_session_id, orders.payment_timestamp,
              reservations.id AS reservation_id,
              reservations.status AS reservation_status
            FROM reservations LEFT JOIN orders ON orders.reservation_id = reservations.id
            WHERE reservations.id = '{args.reservation_id}'
          ) o),
          'duplicate_orders', (SELECT COUNT(*) FROM (
            SELECT reservation_id FROM orders GROUP BY reservation_id HAVING COUNT(*) > 1
          ) duplicates),
          'deployments', (SELECT COALESCE(json_agg(d), '[]'::json) FROM (
            SELECT deployments.live_url, deployments.verified_at,
              deployments.cloudflare_project_name, actions.run_id
            FROM deployments JOIN actions ON actions.id = deployments.last_action_id
            WHERE deployments.tenant_id = (SELECT tenant_id FROM runs WHERE id = '{args.run_id}')
          ) d)
        )
        """,
    )

    artifacts = state.get("artifacts", [])
    artifact_types = [item["artifact_type"] for item in artifacts]
    social_count = artifact_types.count("SOCIAL_POST")
    videos = [item for item in artifacts if item["artifact_type"] in ("VIDEO_LANDSCAPE", "VIDEO_VERTICAL")]
    marketing_copy_grounded, marketing_copy_evidence = verify_marketing_copy(
        artifacts, state.get("catalog", [])
    )
    r2_videos_verified, r2_video_evidence = verify_r2_videos(videos)
    run_brand_document_id = (state.get("run") or {}).get("brand_document_id")
    site_artifacts = state.get("site_artifacts", [])
    brand_references = [item.get("brand_document_id") for item in artifacts + site_artifacts]
    brand_consistent = bool(brand_references) and all(
        reference == run_brand_document_id for reference in brand_references
    )
    marketing_complete = (
        artifact_types.count("LANDING_COPY") == 1
        and 3 <= social_count <= 5
        and artifact_types.count("LAUNCH_EMAIL") == 1
        and artifact_types.count("VIDEO_STORYBOARD") == 1
        and {item["artifact_type"] for item in videos} == {"VIDEO_LANDSCAPE", "VIDEO_VERTICAL"}
        and all(item["r2_object_key"] and item["mime_type"] == "video/mp4" for item in videos)
        and all(item["self_review_status"] == "PASSED" and item["grounding_check_status"] == "PASSED" for item in artifacts)
        and all(item["approval_status"] == "APPROVED" for item in videos)
        and all(
            item["approval_status"] == "APPROVED"
            for item in artifacts if item["artifact_type"] == "VIDEO_STORYBOARD"
        )
        and marketing_copy_grounded
        and r2_videos_verified
        and brand_consistent
    )
    order = state.get("order") or {}
    stripe_session_verified, stripe_session_evidence = verify_stripe_session(
        order, state.get("run") or {}
    )
    catalog = state.get("catalog", [])
    html_lower = business_html.lower()
    expected_strings = []
    for item in catalog:
        expected_strings.extend(
            [
                item["name"],
                f"{int(item['day_rate_cents']) / 100:.2f}",
                item["currency"].upper(),
            ]
        )
    if catalog:
        expected_strings.extend(
            [catalog[0]["business_email"], catalog[0]["business_phone"], catalog[0]["business_address"]]
        )
    grounded_site = (
        business_status == 200
        and "lorem ipsum" not in html_lower
        and "todo" not in html_lower
        and "<meta name=\"viewport\"" in html_lower
        and images_verified
        and all(value and str(value).lower() in html_lower for value in expected_strings)
    )
    calls = state.get("agent_calls", [])
    tasks = state.get("tasks", [])
    actions = state.get("actions", [])
    deployment_actions = [action for action in actions if action["action_type"] == "deploy"]
    video_actions = [action for action in actions if action["action_type"] == "video-render"]
    checkout_actions = [
        action for action in actions if action["action_type"] == "checkout-session"
    ]
    webhook_actions = [
        action for action in actions if action["action_type"] == "process-stripe-webhook"
    ]
    requested_business_url = args.business_url.rstrip("/")
    matching_deployments = [
        deployment
        for deployment in state.get("deployments", [])
        if (deployment.get("live_url") or "").rstrip("/") == requested_business_url
        and deployment.get("verified_at")
        and deployment.get("run_id") == args.run_id
    ]
    fetched_site_hash = hashlib.sha256(business_html.encode("utf-8")).hexdigest()
    matching_site_artifacts = [
        artifact
        for artifact in site_artifacts
        if artifact.get("content_hash") == fetched_site_hash
        and artifact.get("validation_status") == "PASSED"
    ]
    gate_controls = (
        len(checkout_actions) >= 1
        and all(
            action["mode"] == "TEST"
            and action["approval_status"] == "NOT_REQUIRED"
            and action["status"] == "EXECUTED"
            for action in checkout_actions
        )
        and len(webhook_actions) >= 1
        and all(
            action["mode"] == "TEST"
            and action["approval_status"] == "NOT_REQUIRED"
            and action["status"] == "EXECUTED"
            for action in webhook_actions
        )
        and all(action["payload_hash"] for action in actions)
        and len(deployment_actions) >= 1
        and all(
            action["mode"] == "LIVE"
            and action["approval_status"] == "APPROVED"
            and action["approved_by"]
            and action["approved_at"]
            and action["status"] == "EXECUTED"
            and action["executed_at"]
            for action in deployment_actions
        )
        and len(video_actions) == 1
        and all(
            action["mode"] == "LIVE"
            and action["approval_status"] == "APPROVED"
            and action["approved_by"]
            and action["approved_at"]
            and action["status"] == "EXECUTED"
            and action["executed_at"]
            and int(action["provider_cost_microdollars"]) == 640_000
            for action in video_actions
        )
        and all(int(action["provider_cost_microdollars"]) >= 0 for action in actions)
        and len(matching_deployments) == 1
        and int(state.get("duplicate_orders", 1)) == 0
    )
    expected_model_tiers = {
        "strategist": ("gpt-5.6-sol", "sol"),
        "web-builder": ("gpt-5.6-sol", "sol"),
        "marketer": ("gpt-5.6-terra", "terra"),
    }
    observed_agents = {call["agent_name"] for call in calls}
    fixed_tiers = all(
        any(
            call["agent_name"] == agent
            and call["model_id"] == expected[0]
            and call["model_tier"] == expected[1]
            for call in calls
        )
        for agent, expected in expected_model_tiers.items()
    )
    strategist_source = (ROOT / "src" / "runtime" / "strategist.js").read_text(encoding="utf-8")
    strategist_delegates_only = (
        "modelGateway.modelCall" in strategist_source
        and "fetch(" not in strategist_source
        and "OpenAI" not in strategist_source
        and "Stripe" not in strategist_source
    )
    model_cost_microdollars = sum(int(call["cost_microdollars"]) for call in calls)
    approved_model_budget = int(
        (state.get("run") or {}).get("approved_budget_microdollars") or 0
    )
    crew_trace = (
        bool(run_brand_document_id)
        and brand_consistent
        and {"CATALOG_PERSIST", "WEB_BUILD", "MARKETING_PACK"}
        == {task["task_type"] for task in tasks}
        and set(expected_model_tiers).issubset(observed_agents)
        and fixed_tiers
        and all(call["status"] == "COMPLETED" for call in calls)
        and 0 < model_cost_microdollars <= approved_model_budget <= 2_000_000
        and strategist_delegates_only
    )
    design_commits = subprocess.run(
        ["git", "log", "--reverse", "--format=%H", "--", "DESIGN.md"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.splitlines()
    implementation_commits = subprocess.run(
        ["git", "log", "--reverse", "--format=%H", "--", "package.json", "src"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.splitlines()
    design_text = (ROOT / "DESIGN.md").read_text(encoding="utf-8")
    failure_catalog = re.search(
        r"^Failure Catalog\s*$([\s\S]*?)(?=^#{1,6}\s|\Z)",
        design_text,
        re.I | re.M,
    )
    failure_cases = re.findall(
        r"^\s*\d+\.\s+\S+",
        failure_catalog.group(1) if failure_catalog else "",
        re.M,
    )
    design_precedes_implementation = False
    if design_commits and implementation_commits:
        design_precedes_implementation = subprocess.run(
            ["git", "merge-base", "--is-ancestor", design_commits[0], implementation_commits[0]],
            cwd=ROOT,
        ).returncode == 0
    design_ok = design_precedes_implementation and len(failure_cases) >= 5
    clean_clone_ok, clean_clone_evidence = verify_clean_clone()

    results = [
        check_result(checks["live_business_site"], business_status == 200 and bool(matching_deployments) and bool(matching_site_artifacts), f"HTTP {business_status}; exact verified deployment rows={len(matching_deployments)}; matching validated HTML hashes={len(matching_site_artifacts)}"),
        check_result(checks["complete_marketing_pack"], marketing_complete, f"artifact types={artifact_types}; copy: {marketing_copy_evidence}; R2: {r2_video_evidence}"),
        check_result(checks["persisted_paid_order"], order.get("status") == "PAID" and order.get("reservation_status") == "CONFIRMED" and stripe_session_verified, f"order status={order.get('status') or 'missing'}; reservation status={order.get('reservation_status') or 'missing'}; Stripe: {stripe_session_evidence}"),
        check_result(checks["grounded_non_slop_site"], grounded_site, f"checked {len(expected_strings)} catalog/contact strings, viewport, placeholders, and images: {image_evidence}"),
        check_result(checks["crew_trace_and_brand"], crew_trace, f"tasks={len(tasks)}, model calls={len(calls)}, model cost={model_cost_microdollars} microdollars / approved={approved_model_budget} / cap=2000000, brand references consistent={brand_consistent}, fixed tiers={fixed_tiers}, Strategist delegates only={strategist_delegates_only}"),
        check_result(checks["action_gate_controls"], gate_controls, f"actions={len(actions)}, checkout actions={len(checkout_actions)}, webhook actions={len(webhook_actions)}, deploy actions={len(deployment_actions)}, video actions={len(video_actions)}, duplicate order groups={state.get('duplicate_orders')}"),
        check_result(checks["design_first"], design_ok, f"DESIGN.md commits={len(design_commits)}; design precedes first implementation commit={design_precedes_implementation}; numbered failure cases={len(failure_cases)}"),
        check_result(checks["deployed_agency_and_clean_clone"], agency_status == 200 and '"tier":1' in agency_body.replace(" ", "") and auth0_protected and clean_clone_ok, f"agency HTTP {agency_status}; Auth0: {auth0_evidence}; {clean_clone_evidence}"),
    ]
    score = sum(item["earned"] for item in results)
    lines = [
        "# EPYHIA Product Evaluation",
        "",
        f"**Score: {score}/{rubric['total_points']}**",
        "",
        f"Agency: {args.agency_url}",
        f"Business site: {args.business_url}",
        f"Run: `{args.run_id}`",
        f"Reservation: `{args.reservation_id}`",
        "",
        "| Area | Check | Result | Points | Evidence |",
        "|---|---|---:|---:|---|",
    ]
    for item in results:
        evidence = str(item["evidence"]).replace("|", "\\|").replace("\n", " ")
        lines.append(
            f"| {item['area']} | {item['id']} | {'PASS' if item['passed'] else 'FAIL'} | {item['earned']}/{item['points']} | {evidence} |"
        )
    lines.extend(["", "Generated from live HTTP responses and Neon rows; internal task status alone is not accepted as proof.", ""])
    Path(args.output).write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {args.output}: {score}/{rubric['total_points']}")
    raise SystemExit(0 if score == rubric["total_points"] else 1)


if __name__ == "__main__":
    main()
