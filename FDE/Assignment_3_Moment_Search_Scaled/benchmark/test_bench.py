"""Pure regression tests for benchmark accounting and evidence checks."""
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "assignment3_bench", Path(__file__).with_name("bench.py"))
bench = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bench)


class BenchmarkAccountingTests(unittest.TestCase):
    def test_register_batch_counts_http_and_malformed_failures(self):
        responses = iter([
            (202, '{"id":"doc_ok"}', 10),
            (503, "unavailable", 10),
            (202, '{"status":"pending"}', 10),
        ])
        batch = [
            ("https://example/a.pdf", "paper", "a"),
            ("https://example/b.pdf", "paper", "b"),
            ("https://example/c.pdf", "paper", "c"),
        ]
        with patch.object(
                bench, "_req", side_effect=lambda *_args, **_kwargs: next(responses)):
            ids, failures = bench._register_batch(batch, "u1")

        self.assertEqual(ids, ["doc_ok"])
        self.assertEqual(failures, 2)

    def test_search_latency_counts_stream_failures(self):
        responses = iter([[], None, [{"sourceId": "doc_1"}]])
        with patch.object(
                bench, "_sse_citations",
                side_effect=lambda *_args, **_kwargs: next(responses)):
            latency, failures, attempts = bench.measure_search_p95(n=3)

        self.assertGreaterEqual(latency, 0)
        self.assertEqual(failures, 1)
        self.assertEqual(attempts, 3)

    def test_batch_failure_is_not_diluted_by_search_successes(self):
        combined, request_pct = bench.combined_error_rate(
            batch_error_pct=12.5, request_failures=0, request_attempts=1000)

        self.assertEqual(request_pct, 0)
        self.assertEqual(combined, 12.5)

    def test_batch_error_counts_missing_and_nonindexed_sources(self):
        rows = {
            "a": {"status": "indexed"},
            "b": {"status": "failed"},
        }

        error_pct = bench.batch_error_rate(
            total=4, register_failures=1, ids=["a", "b", "c"], rows=rows)

        self.assertEqual(error_pct, 75.0)

    def test_resume_evidence_must_match_current_batch(self):
        lines = [
            "[parse] old_doc: resume from checkpoint",
            "[parse] doc_current: resume from checkpoint",
            "[dispatch] reconciler: requeued 1",
        ]

        self.assertEqual(
            bench.batch_resume_lines(lines, ["doc_current"]), [lines[1]])
        self.assertEqual(bench.batch_resume_lines(lines, ["different_doc"]), [])


if __name__ == "__main__":
    unittest.main()
