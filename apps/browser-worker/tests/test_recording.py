"""Recording timestamps must share the worker clock, including capture startup."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from recording import Recorder


class RecordingTest(unittest.TestCase):
    def test_first_segment_start_uses_encoded_duration_and_preserves_gaps(self):
        with tempfile.TemporaryDirectory() as directory:
            recorder = Recorder(Path(directory))
            recorder.wall_started_ms = 1_700_000_000_000
            for name in ["000000000.ts", "000000001.ts"]:
                (recorder.directory / name).write_bytes(b"video")
            (recorder.directory / "segments.csv").write_text(
                "000000000.ts,0.000000,1700000002.300000\n"
                "000000001.ts,1700000003.300000,1700000005.300000\n")
            with patch("recording.subprocess.run", return_value=SimpleNamespace(stdout=json.dumps({"format": {"duration": "2.000000"}}))):
                recorder.collect()
                recorder.collect()
            self.assertEqual([(s["start_ms"], s["end_ms"], s["status"]) for s in recorder.segments],
                [(0, 300, "gap"), (300, 2300, "ready"), (2300, 3300, "gap"), (3300, 5300, "ready")])
            self.assertEqual([s["sequence"] for s in recorder.segments], [0, 1, 2, 3])


if __name__ == "__main__":
    unittest.main()
